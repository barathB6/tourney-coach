// Reminder cadence library.
//
// Pre-event reminders are time-driven: five offsets before the shotgun, and a
// volunteer's guidance profile decides which subset they receive. Day-of
// reminders are event-driven: they fire when something happens on the course
// (the pace tracker fires the kitchen, the last group finishes), not when a
// clock says so — a 2:00pm "awards soon" text is wrong if the field is forty
// minutes behind.
//
// The band logic is inherited from the volunteer reminder engine (lib/toc/team)
// where it was hard-won: each offset owns the half-open window
// (next-smaller-offset, offset], so exactly one reminder is ever due at any
// moment and a late-created assignment doesn't get three reminders at once,
// each naming a time that has already passed.

import type { Cadence } from '@/lib/guidance/engine';

export interface CadenceOffset {
  key: string;
  minutes: number;
  label: string;
}

/** The spec's five pre-event slots. */
export const PRE_EVENT_OFFSETS: CadenceOffset[] = [
  { key: 'pre_event:10080', minutes: 10_080, label: '7 days out' },
  { key: 'pre_event:2880', minutes: 2_880, label: '48 hours out' },
  { key: 'pre_event:1440', minutes: 1_440, label: '24 hours out' },
  { key: 'pre_event:360', minutes: 360, label: '6 hours out' },
  { key: 'pre_event:30', minutes: 30, label: '30 minutes out' },
];

// Which slots each cadence intensity receives. `full` is the whole ladder;
// `light` is the two that prevent a no-show. Every set keeps 30 minutes —
// no intensity opts out of "it is about to start".
export const CADENCE_SETS: Record<Cadence, number[]> = {
  full: [10_080, 2_880, 1_440, 360, 30],
  standard: [10_080, 1_440, 30],
  light: [1_440, 30],
};

/** Day-of contextual triggers — fired by course events, not the clock. */
export const DAY_OF_TRIGGERS = [
  { key: 'day_of:shotgun_started', label: 'Shotgun started',
    audience: 'all day-of roles', detail: 'The horn has gone — everyone to their stations.' },
  { key: 'day_of:kitchen_fired', label: 'Kitchen fired',
    audience: 'Kitchen Liaison, Awards Setup Crew', detail: 'The pace tracker says the field is ~45 minutes out. Kitchen starts; awards crew stages.' },
  { key: 'day_of:last_group_in', label: 'Last group in',
    audience: 'Scoring Runner, Awards Setup Crew, Takedown Crew', detail: 'Scores close, awards begin, takedown can start on the far holes.' },
] as const;

export type DayOfTriggerKey = (typeof DAY_OF_TRIGGERS)[number]['key'];

const bandFloor = (minutes: number, set: number[]): number => {
  const smaller = set.filter((m) => m < minutes);
  return smaller.length ? Math.max(...smaller) : 0;
};

/**
 * The offsets due RIGHT NOW for one volunteer, given their cadence set, the
 * minutes until their start, and the slots already sent (claimed in the
 * ledger). At most one offset is ever returned per call — the bands partition
 * the timeline — but the return is a list so a caller can assert that.
 */
export function dueOffsets(
  minutesToStart: number,
  cadence: Cadence,
  alreadySentKeys: Set<string>,
): CadenceOffset[] {
  if (!Number.isFinite(minutesToStart) || minutesToStart < 0) return [];
  const set = CADENCE_SETS[cadence] ?? CADENCE_SETS.full;
  const due: CadenceOffset[] = [];
  for (const o of PRE_EVENT_OFFSETS) {
    if (!set.includes(o.minutes)) continue;
    if (alreadySentKeys.has(o.key)) continue;
    if (minutesToStart > o.minutes) continue;                  // not yet in this band
    if (minutesToStart <= bandFloor(o.minutes, set)) continue; // already in a smaller band
    due.push(o);
  }
  return due;
}

/** Reminder copy that names the actual time, never a relative phrase that may
 * already be false by the time the SMS is read. */
export function reminderBody(params: {
  volunteerName: string | null;
  roleName: string;
  tournamentName: string;
  startsAtLabel: string; // e.g. "Saturday 6:30 AM"
  offset: CadenceOffset;
  portalUrl: string;
}): { subject: string; body: string } {
  const name = params.volunteerName ? `${params.volunteerName.split(' ')[0]}, ` : '';
  return {
    subject: `${params.roleName} — ${params.offset.label} · ${params.tournamentName}`,
    body: `${name}your ${params.roleName} shift for ${params.tournamentName} starts ${params.startsAtLabel}. `
      + `Your checklist and updates: ${params.portalUrl}`,
  };
}
