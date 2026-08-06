// The pre-event reminder run: for every confirmed or still-unanswered
// assignment on an upcoming tournament, work out which cadence slot (if any)
// is due for that volunteer right now, and send it through the comm engine on
// the channel their guidance profile picked.
//
// Idempotency is layered:
//   1. dueOffsets() band logic — at most one slot is due at a time.
//   2. The set of already-sent offset keys is read from the ledger first.
//   3. The ledger's partial unique index — two concurrent runs racing the same
//      slot resolve at the database, not in application hope.
//
// TIMING HONESTY: Vercel's Hobby plan runs crons daily, so a daily run catches
// the 7d/48h/24h slots reliably; the 6h and 30m slots land only when a run
// happens inside their band. runCadence() itself is correct at any frequency —
// it is also called from the organizer's "Send due reminders now" button, and
// day-of it should be triggered alongside the pace poll. The engine does not
// pretend otherwise.

import type { SupabaseClient } from '@supabase/supabase-js';
import { dueOffsets, reminderBody, PRE_EVENT_OFFSETS } from '@/lib/comm/cadence';
import { sendComm } from '@/lib/comm/engine';
import { loadProfile } from '@/lib/guidance/profile';
import { roleStartAt } from '@/lib/toc/team';
import type { Phase } from '@/lib/toc/phase';
import { formatEventTime } from '@/lib/formatEventDate';
import { getPublicAppUrl } from '@/lib/publicUrl';
import type { Cadence } from '@/lib/guidance/engine';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

export interface CadenceRunResult {
  tournaments: number;
  considered: number;
  sent: number;
  failed: number;
  alreadyClaimed: number;
  details: { volunteerId: string; offsetKey: string; channel: string; ok: boolean; error?: string }[];
}

const dayLabel = (d: Date) =>
  `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })} at ${formatEventTime(d.toISOString())}`;

// `tournamentId` narrows the run to one event. The nightly cron omits it and
// sweeps everything; ANY caller acting for a single organizer must pass it.
//
// It used to be optional in practice as well as in the signature, and the
// organizer's "Send due reminders now" button did not pass it. One organizer
// pressing that button therefore sent another organizer's volunteers their
// SMS and email, and got back `details` rows carrying the other tenant's
// volunteer UUIDs and raw provider errors. The owner check upstream proved
// ownership of the tournament in the URL and nothing else.
export async function runCadence(service: DB, now = new Date(), tournamentId?: string): Promise<CadenceRunResult> {
  const result: CadenceRunResult = { tournaments: 0, considered: 0, sent: 0, failed: 0, alreadyClaimed: 0, details: [] };

  // Tournaments starting within the largest offset window (7 days + a day of
  // slack for the daily cron).
  const horizon = new Date(now.getTime() + 8 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  let q = service.from('tournaments')
    .select('id, name, event_date, shotgun_time')
    .gte('event_date', today).lte('event_date', horizon);
  if (tournamentId) q = q.eq('id', tournamentId);
  const { data: tournaments } = await q;

  // The role→earliest-task-offset map, fetched ONCE.
  //
  // This used to be a query per assignment, inside two nested loops. task_templates
  // is a small reference table that is identical for every tournament, so the
  // nightly sweep was issuing one round trip per volunteer per tournament to
  // re-read the same handful of rows — the single worst N+1 on the cron path,
  // and it grows with the whole platform rather than with one event.
  const { data: allTasks } = await service.from('task_templates')
    .select('role_template_id, due_offset_hours');
  const earliestOffsetByRole = new Map<string, number>();
  for (const t of allTasks ?? []) {
    const rid = t.role_template_id as string | null;
    const off = t.due_offset_hours as number | null;
    if (!rid || off == null) continue;
    const prev = earliestOffsetByRole.get(rid);
    if (prev == null || off < prev) earliestOffsetByRole.set(rid, off);
  }

  for (const t of tournaments ?? []) {
    result.tournaments++;

    const { data: assigns } = await service.from('tournament_volunteer_assignments')
      .select('id, volunteer_id, status, role_template_id, role_templates(name, phase), volunteers(name, email, phone)')
      .eq('tournament_id', t.id as string)
      .in('status', ['assigned', 'confirmed']);

    for (const a of assigns ?? []) {
      const role = a.role_templates as unknown as { name?: string; phase?: string } | null;
      const vol = a.volunteers as unknown as { name?: string; email?: string; phone?: string } | null;
      const phase = (role?.phase === 'day_of' ? 'day_of' : 'planning') as Phase;

      // Reminders anchor to when THIS role starts, not the shotgun: the
      // registration lead's "30 minutes out" is 30 minutes before their
      // 6:30am call time, not before the horn.
      const earliest = earliestOffsetByRole.get(a.role_template_id as string) ?? null;
      const startsAt = roleStartAt(phase, earliest,
        t.event_date as string | null, t.shotgun_time as string | null);
      if (!startsAt) continue;

      const minutesToStart = (startsAt.getTime() - now.getTime()) / 60_000;
      if (minutesToStart < 0) continue;
      result.considered++;

      const profile = await loadProfile(service, t.id as string, a.volunteer_id as string);

      const { data: sentRows } = await service.from('communication_log')
        .select('offset_key').eq('volunteer_id', a.volunteer_id as string)
        .eq('kind', 'reminder').not('offset_key', 'is', null);
      const sentKeys = new Set((sentRows ?? []).map((r) => r.offset_key as string));

      const due = dueOffsets(minutesToStart, profile.cadence as Cadence, sentKeys);
      for (const offset of due) {
        const { subject, body } = reminderBody({
          volunteerName: vol?.name ?? null,
          roleName: role?.name ?? 'Volunteer',
          tournamentName: (t.name as string) ?? 'the tournament',
          startsAtLabel: dayLabel(startsAt),
          offset,
          portalUrl: `${getPublicAppUrl()}/volunteer/confirm/${await tokenFor(service, a.id as string)}`,
        });

        const outcome = await sendComm(service, {
          recipient: {
            volunteerId: a.volunteer_id as string,
            tournamentId: t.id as string,
            name: vol?.name ?? null,
            email: vol?.email ?? null,
            phone: vol?.phone ?? null,
          },
          kind: 'reminder',
          subject, body,
          channel: profile.channel,
          offsetKey: offset.key,
          meta: { cadence: profile.cadence, depth: profile.depth },
        });

        if (outcome.alreadyClaimed) result.alreadyClaimed++;
        else if (outcome.ok) result.sent++;
        else result.failed++;
        result.details.push({
          volunteerId: a.volunteer_id as string, offsetKey: offset.key,
          channel: outcome.channel, ok: outcome.ok, error: outcome.error,
        });
      }
    }
  }

  return result;
}

async function tokenFor(service: DB, assignmentId: string): Promise<string> {
  const { data } = await service.from('tournament_volunteer_assignments')
    .select('invite_token').eq('id', assignmentId).maybeSingle();
  return (data?.invite_token as string | null) ?? '';
}

export { PRE_EVENT_OFFSETS };
