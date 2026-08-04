// Gathering the five signals from the database and keeping the stored profile
// current. computeGuidance (lib/guidance/engine) stays pure; this file is the
// only place that knows where signals live.
//
// Recomputation triggers, per the spec: task completion, engagement events,
// post-tournament feedback. All three funnel through recordGuidanceEvent(), so
// there is exactly one door — an event is appended, the profile is recomputed
// from scratch, and the row records why. Recompute is a full recomputation
// rather than an incremental patch: profiles must never depend on the order
// events happened to arrive in.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeGuidance, type GuidanceProfile, type GuidanceSignals, type Channel,
} from '@/lib/guidance/engine';
import { shotgunInstant } from '@/lib/fb/plan';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

/** How long an unopened email waits before it counts as ignored. */
export const IGNORED_EMAIL_AFTER_MS = 48 * 3_600_000;

export type GuidanceEventKind =
  | 'portal_viewed' | 'task_completed' | 'task_uncompleted' | 'message_sent'
  | 'invite_responded' | 'reminder_sent' | 'feedback';

/** Assemble the five signals for one volunteer. */
export async function gatherSignals(service: DB, tournamentId: string, volunteerId: string): Promise<GuidanceSignals | null> {
  const { data: vol } = await service.from('volunteers')
    .select('id, name, email, phone').eq('id', volunteerId).eq('tournament_id', tournamentId).maybeSingle();
  if (!vol) return null;

  const [{ data: t }, { data: assigns }, { data: events }, { data: subs }, { data: comms }] = await Promise.all([
    service.from('tournaments').select('event_date, shotgun_time').eq('id', tournamentId).maybeSingle(),
    service.from('tournament_volunteer_assignments')
      .select('id, status, invited_at, responded_at, role_template_id, role_templates(name, phase)')
      .eq('tournament_id', tournamentId).eq('volunteer_id', volunteerId),
    service.from('guidance_events').select('kind, payload, created_at')
      .eq('volunteer_id', volunteerId).order('created_at', { ascending: false }).limit(500),
    service.from('push_subscriptions').select('id').eq('volunteer_id', volunteerId).limit(1),
    service.from('communication_log').select('channel, status, read_at, sent_at')
      .eq('volunteer_id', volunteerId).eq('channel', 'email').limit(50),
  ]);

  const assignments = assigns ?? [];
  const assignmentIds = assignments.map((a) => a.id as string);
  const { data: realCompletions } = assignmentIds.length
    ? await service.from('volunteer_task_completions').select('completed_late').in('assignment_id', assignmentIds)
    : { data: [] as { completed_late: boolean }[] };

  // Prior tournaments: the same human, matched by email, volunteering at OTHER
  // tournaments. No email means no history we can trust.
  let priorTournaments = 0;
  let priorNoShows = 0;
  const email = (vol.email as string | null)?.trim().toLowerCase();
  if (email) {
    const { data: priors } = await service.from('volunteers')
      .select('id, tournament_id, checked_in_at').ilike('email', email).neq('tournament_id', tournamentId);
    priorTournaments = new Set((priors ?? []).map((p) => p.tournament_id as string)).size;
    if (priors?.length) {
      const priorIds = priors.map((p) => p.id as string);
      const { data: priorAssigns } = await service.from('tournament_volunteer_assignments')
        .select('volunteer_id, status, role_templates(phase)').in('volunteer_id', priorIds);
      for (const p of priors) {
        const confirmedDayOf = (priorAssigns ?? []).some((a) => a.volunteer_id === p.id
          && a.status === 'confirmed'
          && (a.role_templates as unknown as { phase?: string } | null)?.phase === 'day_of');
        if (confirmedDayOf && !p.checked_in_at) priorNoShows++;
      }
    }
  }

  const primary = assignments[0] ?? null;
  const role = primary?.role_templates as unknown as { name?: string; phase?: string } | null;

  const evs = events ?? [];
  const feedbackEv = evs.find((e) => e.kind === 'feedback');
  const fb = (feedbackEv?.payload ?? {}) as { wantsMoreDetail?: boolean; wantsLessDetail?: boolean; preferredChannel?: Channel };

  const invitedAt = primary?.invited_at ? Date.parse(primary.invited_at as string) : NaN;
  const respondedAt = primary?.responded_at ? Date.parse(primary.responded_at as string) : NaN;
  const latency = Number.isFinite(invitedAt) && Number.isFinite(respondedAt) && respondedAt >= invitedAt
    ? (respondedAt - invitedAt) / 3_600_000 : null;

  const eventDate = (t?.event_date as string | null) ?? null;
  const shotgunAt = shotgunInstant(eventDate, (t?.shotgun_time as string | null) ?? null);
  const now = Date.now();
  const daysToEvent = shotgunAt ? Math.floor((Date.parse(shotgunAt) - now) / 86_400_000) : null;
  const isEventDay = eventDate ? eventDate.slice(0, 10) === new Date(now).toISOString().slice(0, 10) : false;

  const lateCount = (realCompletions ?? []).filter((c) => c.completed_late).length;

  return {
    role: { phase: (role?.phase === 'day_of' ? 'day_of' : 'planning'), roleName: role?.name ?? 'Volunteer' },
    experience: { priorTournaments, declaredLevel: null },
    state: { daysToEvent, isEventDay },
    engagement: {
      portalViews: evs.filter((e) => e.kind === 'portal_viewed').length,
      responseLatencyHours: latency,
      messagesSent: evs.filter((e) => e.kind === 'message_sent').length,
      // Only emails old enough to be genuinely ignored. An email sent five
      // minutes ago has not been "unopened" — counting it would bounce someone
      // onto SMS for being asleep. Opens arrive via the SendGrid event webhook
      // (custom_args comm_log_id), which stamps read_at.
      unopenedEmails: (comms ?? []).filter((c) => {
        if (c.read_at || c.status !== 'sent') return false;
        const sent = c.sent_at ? Date.parse(c.sent_at as string) : NaN;
        return Number.isFinite(sent) && now - sent > IGNORED_EMAIL_AFTER_MS;
      }).length,
      hasPhone: !!(vol.phone as string | null),
      hasPushSubscription: (subs ?? []).length > 0,
    },
    performance: {
      tasksCompleted: (realCompletions ?? []).length,
      tasksCompletedLate: lateCount,
      priorNoShows,
    },
    feedback: {
      wantsMoreDetail: fb.wantsMoreDetail === true,
      wantsLessDetail: fb.wantsLessDetail === true,
      preferredChannel: fb.preferredChannel ?? null,
    },
  };
}

/** Recompute and store. Returns the fresh profile, or null if the volunteer is gone. */
export async function recomputeProfile(
  service: DB, tournamentId: string, volunteerId: string, reason: string,
): Promise<GuidanceProfile | null> {
  const signals = await gatherSignals(service, tournamentId, volunteerId);
  if (!signals) return null;
  const profile = computeGuidance(signals);

  await service.from('volunteer_guidance_profiles').upsert({
    tournament_id: tournamentId,
    volunteer_id: volunteerId,
    experience_level: profile.experienceLevel,
    depth: profile.depth,
    cadence: profile.cadence,
    channel: profile.channel,
    signals: signals as unknown as Record<string, unknown>,
    computed_at: new Date().toISOString(),
    recompute_reason: reason,
  }, { onConflict: 'tournament_id,volunteer_id' });

  return profile;
}

/**
 * The one door for everything that should update a profile: append the event,
 * recompute from scratch. Task completions, engagement, feedback — all three
 * spec'd triggers come through here.
 */
export async function recordGuidanceEvent(
  service: DB, tournamentId: string, volunteerId: string,
  kind: GuidanceEventKind, payload?: Record<string, unknown>,
): Promise<GuidanceProfile | null> {
  await service.from('guidance_events').insert({
    tournament_id: tournamentId, volunteer_id: volunteerId, kind, payload: payload ?? null,
  });
  return recomputeProfile(service, tournamentId, volunteerId, `event:${kind}`);
}

/** Load the stored profile, computing it on first sight. */
export async function loadProfile(
  service: DB, tournamentId: string, volunteerId: string,
): Promise<GuidanceProfile & { computedAt: string | null }> {
  const { data } = await service.from('volunteer_guidance_profiles')
    .select('*').eq('tournament_id', tournamentId).eq('volunteer_id', volunteerId).maybeSingle();
  if (data) {
    // Reasons are re-derived from the stored signal snapshot — computeGuidance
    // is deterministic, so this reproduces exactly what was decided and why.
    let reasons: string[] = [];
    try { reasons = computeGuidance(data.signals as unknown as GuidanceSignals).reasons; }
    catch { reasons = ['Stored signals predate the current engine version.']; }
    return {
      experienceLevel: data.experience_level, depth: data.depth, cadence: data.cadence,
      channel: data.channel, reasons,
      computedAt: data.computed_at as string,
    };
  }
  const fresh = await recomputeProfile(service, tournamentId, volunteerId, 'first_load');
  return fresh
    ? { ...fresh, computedAt: new Date().toISOString() }
    : { experienceLevel: 'first_timer', depth: 'detailed', cadence: 'full', channel: 'email', reasons: ['Defaults — volunteer not found.'], computedAt: null };
}
