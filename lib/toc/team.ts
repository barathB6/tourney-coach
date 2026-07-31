import type { SupabaseClient } from '@supabase/supabase-js';
import { anchorFor, dueAt, type Phase } from './phase';
import { sendVolunteerInviteEmail, volunteerInviteSms, volunteerReminderSms } from '@/lib/email/volunteerInvite';
import { sendSms, toE164 } from '@/lib/sms/twilio';

// Day 27 — the volunteer roles engine.
//
// Planning and day-of teams are recruited on different clocks (12–16 weeks vs
// 4–8 weeks) and reminded on different ones too, but they run through the same
// assignment → invite → confirm → remind pipeline. That shared pipeline lives
// here so the two team views can't drift apart.

// 7 days, 2 days, 90 minutes before the role starts.
export const REMINDER_OFFSETS_MINUTES = [10_080, 2_880, 90] as const;

export function reminderLabel(offsetMinutes: number): string {
  if (offsetMinutes >= 1440) {
    const days = Math.round(offsetMinutes / 1440);
    return `in ${days} day${days === 1 ? '' : 's'}`;
  }
  // Threshold at two hours, not one: the 90-minute reminder should say "in 90
  // minutes" the way the spec (and a person) phrases it, not "in 2 hours" —
  // which is both a rounding lie and less urgent-sounding than it should be.
  if (offsetMinutes >= 120) {
    const h = Math.round(offsetMinutes / 60);
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `in ${offsetMinutes} minutes`;
}

// When a role actually starts. A day-of role starts at its earliest task (the
// registration lead is there two hours before the horn); a planning role starts
// at its earliest task too, which is weeks out. Falls back to the phase anchor
// when a role somehow carries no tasks.
export function roleStartAt(
  phase: Phase,
  earliestOffsetHours: number | null,
  eventDate: string | null,
  shotgunTime: string | null,
): Date | null {
  if (earliestOffsetHours != null) return dueAt(phase, earliestOffsetHours, eventDate, shotgunTime);
  return anchorFor(phase, eventDate, shotgunTime);
}

export interface TeamMember {
  assignmentId: string;
  volunteerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  roleId: string;
  roleName: string;
  phase: Phase;
  status: string;              // assigned | confirmed | declined | completed
  invitedAt: string | null;
  respondedAt: string | null;
  inviteChannel: string | null;
  inviteError: string | null;
  startsAt: string | null;
  remindersSent: number[];     // offsets already delivered
  checkedInAt: string | null;
  // Confirmed, their role has started, and they never checked in. Only ever
  // true for day-of roles: a planning role "starting" 16 weeks out has no
  // check-in desk to miss.
  noShow: boolean;
}

export interface TeamRole {
  id: string;
  name: string;
  description: string | null;
  phase: Phase;
  sortOrder: number;
  taskTitles: string[];
  earliestOffsetHours: number | null;
  members: TeamMember[];
}

export interface TeamSnapshot {
  tournament: { id: string; name: string; eventDate: string | null; shotgunTime: string | null };
  roles: TeamRole[];
  summary: {
    planningFilled: number; planningTotal: number;
    dayOfFilled: number; dayOfTotal: number;
    awaitingResponse: number; declined: number; noShows: number;
  };
}

// How long after a role starts before an absence counts as a no-show. Someone
// two minutes late is not a no-show; someone twenty minutes late means the
// registration table is unmanned and the organizer needs to know NOW, while
// there is still time to move somebody.
export const NO_SHOW_GRACE_MINUTES = 20;

export function isNoShow(
  phase: Phase,
  status: string,
  startsAt: Date | null,
  checkedInAt: string | null,
  now: Date,
): boolean {
  // Planning roles have no check-in desk, so absence is not measurable.
  if (phase !== 'day_of') return false;
  if (status !== 'confirmed') return false;   // nobody promised, nobody missed
  if (checkedInAt) return false;
  if (!startsAt) return false;
  return now.getTime() - startsAt.getTime() > NO_SHOW_GRACE_MINUTES * 60_000;
}

export async function loadTeam(
  service: SupabaseClient,
  tournamentId: string,
  now: Date = new Date(),
): Promise<TeamSnapshot | null> {
  const { data: t } = await service.from('tournaments')
    .select('id, name, event_date, shotgun_time').eq('id', tournamentId).maybeSingle();
  if (!t) return null;

  const eventDate = (t.event_date as string | null) ?? null;
  const shotgunTime = (t.shotgun_time as string | null) ?? null;

  const [{ data: roleRows }, { data: taskRows }, { data: assignRows }] = await Promise.all([
    service.from('role_templates').select('id, name, description, phase, sort_order').order('sort_order'),
    service.from('task_templates').select('role_template_id, title, due_offset_hours').order('sort_order'),
    service.from('tournament_volunteer_assignments')
      .select('id, volunteer_id, role_template_id, status, invited_at, responded_at, invite_channel, invite_error, volunteers(name, email, phone, checked_in_at)')
      .eq('tournament_id', tournamentId),
  ]);

  const assignmentIds = (assignRows ?? []).map((a) => a.id as string);
  const { data: reminderRows } = assignmentIds.length
    ? await service.from('volunteer_reminders')
        .select('assignment_id, offset_minutes').in('assignment_id', assignmentIds).eq('status', 'sent')
    : { data: [] as { assignment_id: string; offset_minutes: number }[] };

  const remindersBy = new Map<string, number[]>();
  for (const r of reminderRows ?? []) {
    const id = r.assignment_id as string;
    if (!remindersBy.has(id)) remindersBy.set(id, []);
    remindersBy.get(id)!.push(r.offset_minutes as number);
  }

  const tasksBy = new Map<string, { title: string; offset: number | null }[]>();
  for (const t2 of taskRows ?? []) {
    const rid = t2.role_template_id as string | null;
    if (!rid) continue;
    if (!tasksBy.has(rid)) tasksBy.set(rid, []);
    tasksBy.get(rid)!.push({ title: t2.title as string, offset: (t2.due_offset_hours as number | null) ?? null });
  }

  const assignsBy = new Map<string, typeof assignRows>();
  for (const a of assignRows ?? []) {
    const rid = a.role_template_id as string | null;
    if (!rid) continue;
    if (!assignsBy.has(rid)) assignsBy.set(rid, []);
    assignsBy.get(rid)!.push(a);
  }

  const roles: TeamRole[] = (roleRows ?? []).map((r) => {
    const phase = (r.phase as Phase) ?? 'planning';
    const tasks = tasksBy.get(r.id as string) ?? [];
    const offsets = tasks.map((x) => x.offset).filter((x): x is number => x != null);
    const earliest = offsets.length ? Math.min(...offsets) : null;
    const startsAt = roleStartAt(phase, earliest, eventDate, shotgunTime);

    const members: TeamMember[] = (assignsBy.get(r.id as string) ?? []).map((a) => {
      const v = a.volunteers as unknown as { name?: string; email?: string | null; phone?: string | null; checked_in_at?: string | null } | null;
      return {
        assignmentId: a.id as string,
        volunteerId: a.volunteer_id as string,
        name: v?.name ?? 'Unnamed volunteer',
        email: v?.email ?? null,
        phone: v?.phone ?? null,
        roleId: r.id as string,
        roleName: r.name as string,
        phase,
        status: (a.status as string) ?? 'assigned',
        invitedAt: (a.invited_at as string | null) ?? null,
        respondedAt: (a.responded_at as string | null) ?? null,
        inviteChannel: (a.invite_channel as string | null) ?? null,
        inviteError: (a.invite_error as string | null) ?? null,
        startsAt: startsAt ? startsAt.toISOString() : null,
        remindersSent: remindersBy.get(a.id as string) ?? [],
        checkedInAt: v?.checked_in_at ?? null,
        noShow: isNoShow(phase, (a.status as string) ?? 'assigned', startsAt, v?.checked_in_at ?? null, now),
      };
    });

    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string | null) ?? null,
      phase,
      sortOrder: (r.sort_order as number) ?? 0,
      taskTitles: tasks.map((x) => x.title),
      earliestOffsetHours: earliest,
      members,
    };
  });

  // A role counts as filled when someone is on it who has not declined. An
  // unanswered invite still counts as filled for planning purposes — the
  // organizer has done their part — but it is surfaced separately so nobody
  // mistakes "asked" for "confirmed".
  const active = (m: TeamMember) => m.status !== 'declined';
  const planning = roles.filter((r) => r.phase === 'planning');
  const dayOf = roles.filter((r) => r.phase === 'day_of');

  return {
    tournament: { id: t.id as string, name: t.name as string, eventDate, shotgunTime },
    roles,
    summary: {
      planningFilled: planning.filter((r) => r.members.some(active)).length,
      planningTotal: planning.length,
      dayOfFilled: dayOf.filter((r) => r.members.some(active)).length,
      dayOfTotal: dayOf.length,
      awaitingResponse: roles.flatMap((r) => r.members).filter((m) => m.invitedAt && !m.respondedAt).length,
      declined: roles.flatMap((r) => r.members).filter((m) => m.status === 'declined').length,
      noShows: roles.flatMap((r) => r.members).filter((m) => m.noShow).length,
    },
  };
}

// ── Invitations ─────────────────────────────────────────────────────────────

export interface InviteResult { ok: boolean; channels: string[]; error?: string }

export async function sendVolunteerInvite(
  service: SupabaseClient,
  assignmentId: string,
  origin: string,
): Promise<InviteResult> {
  const { data: a } = await service.from('tournament_volunteer_assignments')
    .select('id, invite_token, tournament_id, role_template_id, volunteers(name, email, phone), tournaments(name, event_date, shotgun_time)')
    .eq('id', assignmentId).maybeSingle();
  if (!a) return { ok: false, channels: [], error: 'Assignment not found' };

  const v = a.volunteers as unknown as { name?: string; email?: string | null; phone?: string | null } | null;
  const t = a.tournaments as unknown as { name?: string; event_date?: string | null; shotgun_time?: string | null } | null;

  const { data: role } = await service.from('role_templates')
    .select('name, description, phase').eq('id', a.role_template_id as string).maybeSingle();
  const { data: tasks } = await service.from('task_templates')
    .select('title, due_offset_hours').eq('role_template_id', a.role_template_id as string).order('sort_order');

  const phase = ((role?.phase as Phase) ?? 'planning');
  const offsets = (tasks ?? []).map((x) => x.due_offset_hours as number | null).filter((x): x is number => x != null);
  const startsAt = roleStartAt(phase, offsets.length ? Math.min(...offsets) : null,
    t?.event_date ?? null, t?.shotgun_time ?? null);

  const confirmUrl = `${origin}/volunteer/confirm/${a.invite_token}`;
  const channels: string[] = [];
  const errors: string[] = [];

  if (v?.email) {
    const r = await sendVolunteerInviteEmail({
      toEmail: v.email,
      volunteerName: v.name ?? 'there',
      tournamentName: t?.name ?? 'the tournament',
      roleName: role?.name ?? 'a role',
      roleDescription: (role?.description as string | null) ?? null,
      phaseLabel: phase === 'planning' ? 'planning-phase' : 'day-of',
      whenLabel: startsAt ? startsAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : null,
      tasks: (tasks ?? []).map((x) => x.title as string),
      confirmUrl,
      organizerName: null,
    });
    if (r.ok) channels.push('email'); else errors.push(`email: ${r.error}`);
  }

  const phone = toE164(v?.phone ?? null);
  if (phone) {
    const r = await sendSms({
      to: phone,
      body: volunteerInviteSms({
        volunteerName: v?.name ?? 'there',
        tournamentName: t?.name ?? 'the tournament',
        roleName: role?.name ?? 'a role',
        confirmUrl,
      }),
    });
    if (r.ok) channels.push('sms'); else errors.push(`sms: ${r.error}`);
  }

  if (!v?.email && !phone) {
    return { ok: false, channels: [], error: 'This volunteer has no email or phone on file.' };
  }

  // Recording the attempt either way: an organizer needs to see "we tried and
  // SendGrid rejected it" rather than a row that silently looks un-invited.
  await service.from('tournament_volunteer_assignments').update({
    invited_at: new Date().toISOString(),
    invite_channel: channels.join('+') || null,
    invite_error: channels.length ? null : errors.join('; ').slice(0, 400),
  }).eq('id', assignmentId);

  if (!channels.length) return { ok: false, channels, error: errors.join('; ') };
  return { ok: true, channels };
}

// ── Reminders ───────────────────────────────────────────────────────────────
// Fired by a scheduled check. Only confirmed volunteers get reminded — chasing
// someone who declined is how you get them to stop reading your texts.
export async function runVolunteerReminders(
  service: SupabaseClient,
  tournamentId: string,
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number; details: string[] }> {
  const team = await loadTeam(service, tournamentId, now);
  if (!team) return { sent: 0, skipped: 0, details: ['tournament not found'] };

  let sent = 0, skipped = 0;
  const details: string[] = [];

  for (const role of team.roles) {
    for (const m of role.members) {
      if (m.status !== 'confirmed' || !m.startsAt) { skipped += 1; continue; }
      const startsAt = new Date(m.startsAt);
      const minutesOut = (startsAt.getTime() - now.getTime()) / 60_000;

      // Each reminder owns a BAND, not an open-ended window. "Inside the
      // window" alone is true of every larger offset at once, so a volunteer
      // confirmed 100 minutes before the horn would be sent the 7-day and
      // 2-day reminders simultaneously — both of them lying about the time.
      // Bands mean exactly one reminder is ever due, and a late addition
      // simply gets fewer of them rather than a burst of wrong ones.
      const bandFor = (offset: number) => {
        const smaller = REMINDER_OFFSETS_MINUTES.filter((o) => o < offset);
        return smaller.length ? Math.max(...smaller) : 0;
      };

      for (const offset of REMINDER_OFFSETS_MINUTES) {
        if (m.remindersSent.includes(offset)) continue;
        // Past the role start: nothing to remind anyone about.
        if (minutesOut < 0) continue;
        if (minutesOut > offset || minutesOut <= bandFor(offset)) continue;

        const phone = toE164(m.phone);
        if (!phone) { skipped += 1; continue; }

        const body = volunteerReminderSms({
          roleName: m.roleName,
          tournamentName: team.tournament.name,
          whenLabel: startsAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
          // ACTUAL time remaining, not the band's nominal offset. Someone
          // confirmed late lands in the 2-day band 100 minutes before the
          // horn; telling them "in 2 days" would be a straight falsehood.
          offsetLabel: reminderLabel(Math.round(minutesOut)),
        });

        // Claim first, then send — same race protection as the kitchen
        // notification. A duplicate key means another instance got there.
        const { error: claimErr } = await service.from('volunteer_reminders').insert({
          assignment_id: m.assignmentId, offset_minutes: offset, channel: 'sms', status: 'sent', message: body,
        });
        if (claimErr) { skipped += 1; continue; }

        const res = await sendSms({ to: phone, body });
        if (!res.ok) {
          await service.from('volunteer_reminders')
            .update({ status: 'failed', error: res.error })
            .eq('assignment_id', m.assignmentId).eq('offset_minutes', offset);
          details.push(`${m.name} ${reminderLabel(offset)}: ${res.error}`);
          skipped += 1;
          continue;
        }
        sent += 1;
        details.push(`${m.name} → ${m.roleName} ${reminderLabel(offset)}`);
      }
    }
  }

  return { sent, skipped, details };
}
