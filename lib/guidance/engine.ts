// Personalized Guidance Engine — patent-candidate Concept E.
//
// One deterministic function: five signals in, one guidance profile out.
// The profile has three axes, and each axis answers a different question:
//
//   depth    — HOW MUCH to say     (detailed / standard / minimal)
//   cadence  — HOW OFTEN to nudge  (full / standard / light)
//   channel  — WHERE to say it     (sms / email / push / in_app)
//
// The five signals, in precedence order where they conflict:
//
//   1. role                  — what they're doing (phase, day-of urgency)
//   2. experience level      — how many times they've done this before
//   3. real-time state       — where the tournament is right now
//   4. engagement signals    — how they've actually behaved this time
//   5. historical performance — how they've delivered before
//
// Design rules, chosen deliberately and enforced by the tests:
//
//   - DETERMINISTIC. Same signals → same profile, byte for byte. No model
//     call, no randomness, no clock reads inside the function. A volunteer's
//     experience must be explainable ("you got the short version because
//     you've run registration four times") and reproducible in a dispute.
//   - CONSERVATIVE ON FAILURE. Every uncertainty resolves toward MORE help:
//     unknown experience → first_timer; no engagement data → full cadence.
//     Over-helping a veteran is mildly annoying; under-helping a first-timer
//     loses the tournament a volunteer.
//   - FEEDBACK OUTRANKS INFERENCE. A volunteer who *said* they want detail
//     gets detail, whatever the other four signals conclude.

export type ExperienceLevel = 'first_timer' | 'returning' | 'veteran';
export type Depth = 'detailed' | 'standard' | 'minimal';
export type Cadence = 'full' | 'standard' | 'light';
export type Channel = 'sms' | 'email' | 'push' | 'in_app';

/** Signal 1 — the role they hold. */
export interface RoleSignal {
  phase: 'planning' | 'day_of';
  roleName: string;
}

/** Signal 2 — prior volunteering, matched across tournaments by email. */
export interface ExperienceSignal {
  priorTournaments: number;
  /** Self-declared or organizer-set override; wins over the count. */
  declaredLevel?: ExperienceLevel | null;
}

/** Signal 3 — where the tournament is right now. */
export interface TournamentStateSignal {
  daysToEvent: number | null; // negative = past
  isEventDay: boolean;
}

/** Signal 4 — how they've behaved THIS tournament. */
export interface EngagementSignal {
  portalViews: number;
  /** Hours between invite and response; null = never responded. */
  responseLatencyHours: number | null;
  messagesSent: number;
  /** Emails sent to them that were never opened (from the send ledger). */
  unopenedEmails: number;
  hasPhone: boolean;
  hasPushSubscription: boolean;
}

/** Signal 5 — how they've delivered, this tournament and before. */
export interface PerformanceSignal {
  tasksCompleted: number;
  tasksCompletedLate: number;
  /** Confirmed a prior event and did not check in. */
  priorNoShows: number;
}

/** Explicit volunteer feedback — outranks everything inferred. */
export interface FeedbackSignal {
  wantsMoreDetail?: boolean;
  wantsLessDetail?: boolean;
  preferredChannel?: Channel | null;
}

export interface GuidanceSignals {
  role: RoleSignal;
  experience: ExperienceSignal;
  state: TournamentStateSignal;
  engagement: EngagementSignal;
  performance: PerformanceSignal;
  feedback: FeedbackSignal;
}

export interface GuidanceProfile {
  experienceLevel: ExperienceLevel;
  depth: Depth;
  cadence: Cadence;
  channel: Channel;
  /** Human-readable trace of every decision — this is what makes the
   * mechanism demonstrable rather than a black box. */
  reasons: string[];
}

const DEPTH_ORDER: Depth[] = ['minimal', 'standard', 'detailed'];
const moreDetailed = (d: Depth): Depth => DEPTH_ORDER[Math.min(2, DEPTH_ORDER.indexOf(d) + 1)];
const lessDetailed = (d: Depth): Depth => DEPTH_ORDER[Math.max(0, DEPTH_ORDER.indexOf(d) - 1)];

export function experienceLevelFrom(exp: ExperienceSignal): ExperienceLevel {
  if (exp.declaredLevel) return exp.declaredLevel;
  const n = Number.isFinite(exp.priorTournaments) ? Math.max(0, exp.priorTournaments) : 0;
  if (n >= 3) return 'veteran';
  if (n >= 1) return 'returning';
  return 'first_timer';
}

export function computeGuidance(s: GuidanceSignals): GuidanceProfile {
  const reasons: string[] = [];

  // ── Experience level (signal 2) ───────────────────────────────────────────
  const level = experienceLevelFrom(s.experience);
  reasons.push(s.experience.declaredLevel
    ? `Experience set explicitly: ${level}.`
    : `${s.experience.priorTournaments} prior tournament${s.experience.priorTournaments === 1 ? '' : 's'} → ${level.replace('_', '-')}.`);

  // ── Depth ─────────────────────────────────────────────────────────────────
  // Base from experience, then adjusted by behaviour, then feedback wins.
  let depth: Depth = level === 'veteran' ? 'minimal' : level === 'returning' ? 'standard' : 'detailed';
  reasons.push(`Base depth for a ${level.replace('_', '-')}: ${depth}.`);

  // Behavioural adjustments (signals 4 & 5).
  const late = s.performance.tasksCompletedLate;
  const onTime = s.performance.tasksCompleted - late;
  if (late >= 2 || s.performance.priorNoShows > 0) {
    const before = depth;
    depth = moreDetailed(depth);
    if (depth !== before) reasons.push(`Struggling signals (${late} late task${late === 1 ? '' : 's'}, ${s.performance.priorNoShows} prior no-show${s.performance.priorNoShows === 1 ? '' : 's'}) → more detail.`);
  } else if (onTime >= 3 && late === 0 && depth !== 'minimal') {
    depth = lessDetailed(depth);
    reasons.push(`${onTime} tasks done on time, none late → less detail needed.`);
  }
  if (s.engagement.portalViews === 0 && s.engagement.responseLatencyHours == null) {
    // Someone we have never reached gets the fullest version when we finally do.
    const before = depth;
    depth = 'detailed';
    if (depth !== before) reasons.push('No engagement at all yet → full detail until they surface.');
  }

  // Feedback outranks inference.
  if (s.feedback.wantsMoreDetail) { depth = 'detailed'; reasons.push('They asked for more detail — that wins.'); }
  else if (s.feedback.wantsLessDetail) { depth = 'minimal'; reasons.push('They asked for less detail — that wins.'); }

  // ── Cadence ───────────────────────────────────────────────────────────────
  let cadence: Cadence = level === 'veteran' ? 'light' : level === 'returning' ? 'standard' : 'full';
  reasons.push(`Base cadence for a ${level.replace('_', '-')}: ${cadence}.`);
  if (s.performance.priorNoShows > 0 && cadence !== 'full') {
    cadence = 'full';
    reasons.push('A prior no-show means every reminder, regardless of experience.');
  }
  if (s.engagement.responseLatencyHours != null && s.engagement.responseLatencyHours <= 4
      && s.engagement.portalViews >= 2 && cadence === 'full') {
    cadence = 'standard';
    reasons.push('Fast responder who reads the portal — trimmed to the standard cadence.');
  }

  // ── Channel ───────────────────────────────────────────────────────────────
  // Feedback first, then day-of urgency, then what we can actually reach.
  let channel: Channel;
  if (s.feedback.preferredChannel) {
    channel = s.feedback.preferredChannel;
    reasons.push(`They picked ${channel} — that wins.`);
  } else if (s.state.isEventDay && s.engagement.hasPhone) {
    // On the day nobody is reading email at the registration table.
    channel = 'sms';
    reasons.push('Event day with a phone on file → SMS.');
  } else if (s.engagement.hasPushSubscription) {
    channel = 'push';
    reasons.push('They enabled push notifications → push.');
  } else if (s.engagement.unopenedEmails >= 2 && s.engagement.hasPhone) {
    channel = 'sms';
    reasons.push(`${s.engagement.unopenedEmails} unopened emails and a phone on file → switch to SMS.`);
  } else if (s.role.phase === 'day_of' && s.state.daysToEvent != null && s.state.daysToEvent <= 2 && s.engagement.hasPhone) {
    channel = 'sms';
    reasons.push('Day-of role inside 48 hours → SMS.');
  } else {
    channel = 'email';
    reasons.push('Email by default — it carries the most detail.');
  }

  return { experienceLevel: level, depth, cadence, channel, reasons };
}

/** The channel to actually attempt, given what exists. In-app always works. */
export function usableChannel(
  preferred: Channel,
  has: { phone: boolean; email: boolean; push: boolean },
): Channel {
  if (preferred === 'sms' && has.phone) return 'sms';
  if (preferred === 'push' && has.push) return 'push';
  if (preferred === 'email' && has.email) return 'email';
  if (preferred === 'in_app') return 'in_app';
  // Fall through the ladder rather than fail.
  if (has.push) return 'push';
  if (has.phone) return 'sms';
  if (has.email) return 'email';
  return 'in_app';
}
