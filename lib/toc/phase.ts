import { parseShotgunTime } from '@/lib/fb/plan';
// Day 26 — the phase-distinct task engine.
//
// Planning work spans 12–16 weeks. Day-of work spans about four hours. They run
// on the same role/task machinery but against different clocks, and this file
// is where that difference is expressed once so nothing downstream has to
// re-derive it.
//
// Both phases store due_offset_hours as hours relative to an anchor, negative
// meaning "before". What differs is which anchor:
//
//   planning  → the event DATE          (-2688h = 16 weeks out)
//   day_of    → the SHOTGUN START time  (-2h    = two hours before the horn)
//
// Keeping one unit means a single ORDER BY sorts a whole role's work correctly
// whichever phase it belongs to; keeping two anchors means a planning task
// doesn't drift when the organizer changes the shotgun time from 8:30 to 9:00.

export type Phase = 'planning' | 'day_of';

export const PHASES: Phase[] = ['planning', 'day_of'];

export const HOURS_PER_WEEK = 168;

export function isPhase(v: unknown): v is Phase {
  return v === 'planning' || v === 'day_of';
}

// The moment a phase's offsets are measured from. Planning anchors to the start
// of the event date; day-of anchors to the shotgun time on that date. When no
// shotgun time is set we fall back to 08:00 local, which is the usual horn and
// keeps the day-of sheet ordered rather than empty.
export function anchorFor(
  phase: Phase,
  eventDate: string | null,
  shotgunTime: string | null,
): Date | null {
  if (!eventDate) return null;
  // The trailing Z is not cosmetic. Without it these strings parse in
  // SERVER-local time, so the same tournament anchored at 08:30 on Vercel (UTC)
  // and at 12:30 UTC on a developer's laptop in Eastern — while every consumer
  // formats the result with timeZone:'UTC' (formatEventTime). Pinning it makes
  // the anchor match what gets printed, in every environment.
  //
  // Note this is the platform's wall-clock convention, not a real instant:
  // shotgun_time is free text with no zone, and tournaments have no timezone
  // column yet. "8:30 AM" is carried through as 08:30Z end to end. See
  // docs/day31-known-issues.md.
  if (phase === 'planning') return new Date(`${eventDate}T00:00:00Z`);
  // Real rows hold "8:30 AM", not "08:30" — the strict-format check here used
  // to reject them and silently anchor every day-of task to 08:00. Same bug,
  // same fix as the F&B kitchen timeline (parseShotgunTime).
  const t = parseShotgunTime(shotgunTime) ?? { hour: 8, minute: 0 };
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  return new Date(`${eventDate}T${hh}:${mm}:00Z`);
}

export function dueAt(
  phase: Phase,
  offsetHours: number | null,
  eventDate: string | null,
  shotgunTime: string | null,
): Date | null {
  const anchor = anchorFor(phase, eventDate, shotgunTime);
  if (!anchor || offsetHours == null) return null;
  return new Date(anchor.getTime() + offsetHours * 3_600_000);
}

// How an offset should READ to a human. A planning task 12 weeks out should not
// say "2016 hours before" — nobody plans in hours at that range, and nobody
// runs a tournament morning in weeks.
export function describeOffset(phase: Phase, offsetHours: number | null): string {
  if (offsetHours == null) return 'no due date';

  if (phase === 'planning') {
    const weeks = Math.round(Math.abs(offsetHours) / HOURS_PER_WEEK);
    if (offsetHours === 0) return 'on event day';
    if (weeks === 0) {
      const days = Math.max(1, Math.round(Math.abs(offsetHours) / 24));
      return offsetHours < 0 ? `${days} day${days === 1 ? '' : 's'} before` : `${days} day${days === 1 ? '' : 's'} after`;
    }
    return offsetHours < 0 ? `${weeks} week${weeks === 1 ? '' : 's'} before` : `${weeks} week${weeks === 1 ? '' : 's'} after`;
  }

  const h = Math.abs(offsetHours);
  if (offsetHours === 0) return 'at the shotgun';
  return offsetHours < 0 ? `${h}h before the shotgun` : `${h}h after the shotgun`;
}

// Planning tasks get an "is this late" signal against today's date; day-of
// tasks are only meaningful during the event itself, so they don't nag in the
// weeks beforehand.
export type TaskStatus = 'upcoming' | 'due_soon' | 'overdue' | 'not_applicable';

export function taskStatus(
  phase: Phase,
  due: Date | null,
  now: Date = new Date(),
  eventDate?: string | null,
): TaskStatus {
  if (!due) return 'not_applicable';

  if (phase === 'day_of') {
    // Only surface day-of tasks on the day itself. Flagging "set up the check-in
    // table" as overdue eleven weeks early is noise that trains people to
    // ignore the list.
    if (!eventDate) return 'not_applicable';
    const sameDay = new Date(`${eventDate}T00:00:00`).toDateString() === now.toDateString();
    if (!sameDay) return 'not_applicable';
  }

  const hoursOut = (due.getTime() - now.getTime()) / 3_600_000;
  if (hoursOut < 0) return 'overdue';
  if (phase === 'planning') return hoursOut <= 7 * 24 ? 'due_soon' : 'upcoming';
  return hoursOut <= 1 ? 'due_soon' : 'upcoming';
}

// ── Tournament Goals ────────────────────────────────────────────────────────
// Progress is always derived from live data, never stored. A stored "42 players
// registered" is a number that silently rots the moment someone refunds.

export interface GoalRow {
  key: 'players' | 'sponsorship' | 'donations' | 'marketing' | 'volunteers';
  label: string;
  target: number | null;
  actual: number;
  unit: 'count' | 'cents';
  percent: number | null;   // null when no target has been set
  met: boolean;
}

export function buildGoals(
  targets: {
    player_goal: number | null;
    sponsorship_goal_cents: number | null;
    donation_items_goal: number | null;
    marketing_reach_goal: number | null;
    volunteer_roles_goal: number | null;
  } | null,
  actuals: {
    players: number;
    sponsorshipCents: number;
    donationItems: number;
    marketingReach: number;
    rolesFilled: number;
  },
): GoalRow[] {
  const row = (
    key: GoalRow['key'], label: string, target: number | null, actual: number, unit: GoalRow['unit'],
  ): GoalRow => ({
    key, label, target, actual, unit,
    // A target of 0 is a real answer ("we're not chasing auction items"), so it
    // counts as met rather than dividing by zero.
    percent: target == null ? null : target === 0 ? 100 : Math.min(100, Math.round((actual / target) * 100)),
    met: target == null ? false : actual >= target,
  });

  return [
    row('players',     'Players registered',   targets?.player_goal ?? null,            actuals.players,          'count'),
    row('sponsorship', 'Sponsorship raised',   targets?.sponsorship_goal_cents ?? null, actuals.sponsorshipCents, 'cents'),
    row('donations',   'Donation items',       targets?.donation_items_goal ?? null,    actuals.donationItems,    'count'),
    row('marketing',   'Marketing reach',      targets?.marketing_reach_goal ?? null,   actuals.marketingReach,   'count'),
    row('volunteers',  'Volunteer roles filled', targets?.volunteer_roles_goal ?? null, actuals.rolesFilled,      'count'),
  ];
}
