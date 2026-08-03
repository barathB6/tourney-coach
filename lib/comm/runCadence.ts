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

export async function runCadence(service: DB, now = new Date()): Promise<CadenceRunResult> {
  const result: CadenceRunResult = { tournaments: 0, considered: 0, sent: 0, failed: 0, alreadyClaimed: 0, details: [] };

  // Tournaments starting within the largest offset window (7 days + a day of
  // slack for the daily cron).
  const horizon = new Date(now.getTime() + 8 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const { data: tournaments } = await service.from('tournaments')
    .select('id, name, event_date, shotgun_time')
    .gte('event_date', today).lte('event_date', horizon);

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
      const { data: tasks } = await service.from('task_templates')
        .select('due_offset_hours').eq('role_template_id', a.role_template_id as string);
      const offsets = (tasks ?? []).map((x) => x.due_offset_hours as number | null).filter((x): x is number => x != null);
      const startsAt = roleStartAt(phase, offsets.length ? Math.min(...offsets) : null,
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
