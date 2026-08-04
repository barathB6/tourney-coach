// Event-driven day-of triggers.
//
// Day 29 established that day-of comms must be EVENT-driven, not clock-driven:
// a 2:00pm "awards soon" text is wrong if the field is forty minutes behind.
// This file is the firing mechanism. Each milestone fires once per tournament
// (enforced by a unique index, not by hope), notifies exactly the roles that
// need it, and records how many were reached.
//
// A trigger can arrive from two places — the organizer's button on the day-of
// dashboard, or the pace tracker inferring it from GPS. Both call fireTrigger();
// whoever gets there first wins and the second is a no-op.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendComm } from '@/lib/comm/engine';
import { loadProfile } from '@/lib/guidance/profile';
import type { Channel } from '@/lib/guidance/engine';
import { getPublicAppUrl } from '@/lib/publicUrl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

export type TriggerKind =
  | 'shotgun_started' | 'last_group_teed' | 'turn_reached'
  | 'first_group_finished' | 'kitchen_fired' | 'last_group_in'
  | 'awards_starting' | 'tournament_complete';

export interface TriggerDef {
  kind: TriggerKind;
  label: string;
  /** Role names notified. Empty = every day-of volunteer. */
  roles: string[];
  /** What the volunteer is actually told. */
  message: string;
  /** One line of organizer-facing context for the button. */
  hint: string;
}

// Roles are matched by name against role_templates. Naming them explicitly (as
// opposed to "everyone") is the point: a Photographer does not need the kitchen
// alert, and a crew that gets every alert stops reading them.
export const TRIGGERS: TriggerDef[] = [
  {
    kind: 'shotgun_started', label: 'Shotgun started', roles: [],
    message: 'The horn has gone — everyone to your stations. Your checklist is in the app.',
    hint: 'Notifies every day-of volunteer that play has begun.',
  },
  {
    kind: 'last_group_teed', label: 'Last group teed off',
    roles: ['Registration Lead', 'Registration Volunteer'],
    message: 'Last group is away. Registration can close down and reconcile the cash box.',
    hint: 'Releases the registration table.',
  },
  {
    kind: 'turn_reached', label: 'Field reached the turn',
    roles: ['Beverage Cart Driver', 'Scoring Runner'],
    message: 'The field is at the turn. Restock the cart and collect the front-nine cards.',
    hint: 'Roughly half the field has passed hole 9 — the first shortage shows up here.',
  },
  {
    kind: 'first_group_finished', label: 'First group finished',
    roles: ['Scoring Runner', 'Awards Setup Crew'],
    message: 'First group is in. Start collecting cards; awards crew can begin staging.',
    hint: 'Scoring goes live and staging starts while the rest of the field is still out.',
  },
  {
    kind: 'kitchen_fired', label: 'Kitchen fired',
    roles: ['Kitchen Liaison', 'Awards Setup Crew'],
    message: 'Kitchen is firing — the field is about 45 minutes out. Confirm service timing.',
    hint: 'The same lead time the F&B plan and the pace tracker both use.',
  },
  {
    kind: 'last_group_in', label: 'Last group in',
    roles: ['Scoring Runner', 'Awards Setup Crew', 'Takedown Crew'],
    message: 'Last group is in. Scores close, awards can begin, takedown can start on the far holes.',
    hint: 'The field is off the course.',
  },
  {
    kind: 'awards_starting', label: 'Awards starting',
    roles: ['Awards Setup Crew', 'Photographer', 'Contest Hole Monitor'],
    message: 'Awards are starting now. Winners, contest results and photos to the front.',
    hint: 'Pulls the people who are needed at the podium.',
  },
  {
    kind: 'tournament_complete', label: 'Tournament complete', roles: [],
    message: 'That is a wrap — thank you. Two quick questions in the app when you have a moment.',
    hint: 'Closes the day and opens the post-tournament feedback that tunes next year’s guidance.',
  },
];

export const triggerDef = (kind: string): TriggerDef | null =>
  TRIGGERS.find((t) => t.kind === kind) ?? null;

export interface FireResult {
  ok: boolean;
  alreadyFired?: boolean;
  notified: number;
  failed: number;
  error?: string;
}

/**
 * Fire one milestone. Idempotent by construction: the event row is claimed
 * BEFORE any notification goes out, so a double-press or a race between the
 * organizer's button and the pace tracker sends nothing twice.
 */
export async function fireTrigger(
  service: DB, tournamentId: string, kind: TriggerKind, firedBy: 'organizer' | 'pace' = 'organizer',
): Promise<FireResult> {
  const def = triggerDef(kind);
  if (!def) return { ok: false, notified: 0, failed: 0, error: 'Unknown trigger.' };

  const { data: claim, error: claimErr } = await service.from('tournament_events').insert({
    tournament_id: tournamentId, kind, fired_by: firedBy,
  }).select('id').single();

  if (claimErr || !claim) {
    if (claimErr?.code === '23505') {
      return { ok: false, alreadyFired: true, notified: 0, failed: 0, error: `${def.label} has already been sent.` };
    }
    return { ok: false, notified: 0, failed: 0, error: claimErr?.message ?? 'Could not record that — run migration 044.' };
  }

  // Who needs to hear it: day-of roles, narrowed to the named ones.
  const { data: roleRows } = await service.from('role_templates')
    .select('id, name, phase').eq('phase', 'day_of');
  const wanted = (roleRows ?? []).filter((r) => def.roles.length === 0 || def.roles.includes(r.name as string));
  const roleIds = wanted.map((r) => r.id as string);

  const { data: assigns } = roleIds.length
    ? await service.from('tournament_volunteer_assignments')
      .select('volunteer_id, volunteers(name, email, phone)')
      .eq('tournament_id', tournamentId).in('role_template_id', roleIds).eq('status', 'confirmed')
    : { data: [] as { volunteer_id: string; volunteers: unknown }[] };

  const seen = new Set<string>();
  let notified = 0;
  let failed = 0;

  for (const a of assigns ?? []) {
    const vid = a.volunteer_id as string;
    if (seen.has(vid)) continue; // one person, two roles, one message
    seen.add(vid);
    const v = a.volunteers as unknown as { name?: string; email?: string; phone?: string } | null;

    const profile = await loadProfile(service, tournamentId, vid);
    const res = await sendComm(service, {
      recipient: {
        volunteerId: vid, tournamentId,
        name: v?.name ?? null, email: v?.email ?? null, phone: v?.phone ?? null,
      },
      kind: 'guidance',
      subject: def.label,
      body: `${def.message}\n\n${getPublicAppUrl()}/v/${await tokenFor(service, tournamentId, vid)}`,
      // Day-of overrides the profile's channel toward SMS when we can: nobody
      // is reading email while carrying a cooler. The engine still degrades if
      // there is no phone.
      channel: (v?.phone ? 'sms' : profile.channel) as Channel,
      meta: { trigger: kind },
    });
    if (res.ok) notified++; else failed++;
  }

  await service.from('tournament_events').update({ notified }).eq('id', claim.id as string);
  return { ok: true, notified, failed };
}

async function tokenFor(service: DB, tournamentId: string, volunteerId: string): Promise<string> {
  const { data } = await service.from('tournament_volunteer_assignments')
    .select('invite_token').eq('tournament_id', tournamentId).eq('volunteer_id', volunteerId)
    .limit(1).maybeSingle();
  return (data?.invite_token as string | null) ?? '';
}

/** Which milestones have fired, in order, for the day-of dashboard. */
export async function loadTriggerState(service: DB, tournamentId: string) {
  const { data } = await service.from('tournament_events')
    .select('kind, fired_at, fired_by, notified').eq('tournament_id', tournamentId);
  const fired = new Map((data ?? []).map((e) => [e.kind as string, e]));
  return TRIGGERS.map((t) => ({
    ...t,
    firedAt: (fired.get(t.kind)?.fired_at as string | null) ?? null,
    firedBy: (fired.get(t.kind)?.fired_by as string | null) ?? null,
    notified: (fired.get(t.kind)?.notified as number | null) ?? 0,
  }));
}
