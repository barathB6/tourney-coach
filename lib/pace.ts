// Module 9 — pace-of-play maths. Pure, no I/O, so the estimator can be tested
// against fixed clocks instead of a live round.
//
// Everything here is derived from real score submissions and their timestamps.
// A team that hasn't posted a hole has no pace and no estimate — we say so
// rather than inventing a position for them.

export const DEFAULT_HOLES = 18;

// Fallback minutes-per-hole for a foursome, used only to season a team's own
// average while they have too few holes for it to mean anything. A scramble
// foursome runs roughly 13–15 min/hole; 14 sits in the middle.
export const ASSUMED_MIN_PER_HOLE = 14;

// How many of a team's own holes it takes before we trust their measured pace
// outright. Below this we blend with the assumption, because one slow tee-off
// (or a group that posted two holes in the first three minutes) would otherwise
// throw the whole finish estimate — and that estimate decides when the kitchen
// starts plating food.
export const TRUST_AFTER_HOLES = 3;

export const KITCHEN_LEAD_MINUTES = 45;

export interface TeamPaceInput {
  registrationId: string;
  teamName: string;
  startingHole: number | null;   // shotgun position; null = conventional 1st tee
  holesCompleted: number;
  firstSubmittedAt: string | null; // ISO — when they posted their first hole
  lastSubmittedAt: string | null;  // ISO — their most recent hole
}

export interface TeamPace {
  registrationId: string;
  teamName: string;
  holesCompleted: number;
  currentHole: number | null;      // the hole they're playing NOW
  holesRemaining: number;
  minutesPerHole: number | null;   // measured (blended) pace
  minutesToFinish: number | null;
  estimatedFinish: string | null;  // ISO
  status: 'not_started' | 'playing' | 'finished';
  pace: 'green' | 'yellow' | 'red' | null;
  minutesSinceLastHole: number | null;
}

// Which hole a team is standing on now. In a shotgun they start somewhere other
// than 1 and wrap around, so this is modular arithmetic, not holesCompleted+1.
export function currentHoleFor(startingHole: number | null, holesCompleted: number, totalHoles = DEFAULT_HOLES): number | null {
  if (holesCompleted >= totalHoles) return null; // done
  const start = startingHole && startingHole >= 1 && startingHole <= totalHoles ? startingHole : 1;
  return ((start - 1 + holesCompleted) % totalHoles) + 1;
}

// A team's minutes-per-hole, blended toward the assumption while their sample
// is thin. Returns null before they've posted anything.
export function minutesPerHole(holesCompleted: number, elapsedMinutes: number): number | null {
  if (holesCompleted <= 0 || elapsedMinutes <= 0) return null;
  const measured = elapsedMinutes / holesCompleted;
  if (holesCompleted >= TRUST_AFTER_HOLES) return measured;
  // Weight measured by how much evidence there is; the rest rides on the
  // assumption. At 1 hole that's 1/3 measured, at 3 holes it's all measured.
  const w = holesCompleted / TRUST_AFTER_HOLES;
  return measured * w + ASSUMED_MIN_PER_HOLE * (1 - w);
}

// Pace relative to the front of the field, in holes behind the leader.
// green ≤1 back, yellow 2–3, red ≥4 (the organizer should make contact).
// Field-relative needs no per-team start clock, which is what makes it work
// for a shotgun where everyone started at once on different holes.
export function paceFromField(holesCompleted: number, fieldMaxThru: number): 'green' | 'yellow' | 'red' | null {
  if (holesCompleted <= 0) return null;
  const behind = fieldMaxThru - holesCompleted;
  return behind <= 1 ? 'green' : behind <= 3 ? 'yellow' : 'red';
}

export function computeTeamPace(
  input: TeamPaceInput,
  now: Date,
  fieldMaxThru: number,
  totalHoles = DEFAULT_HOLES,
): TeamPace {
  const { registrationId, teamName, startingHole, holesCompleted } = input;
  const base = {
    registrationId, teamName, holesCompleted,
    holesRemaining: Math.max(0, totalHoles - holesCompleted),
    currentHole: currentHoleFor(startingHole, holesCompleted, totalHoles),
  };

  if (holesCompleted <= 0 || !input.firstSubmittedAt) {
    return {
      ...base, minutesPerHole: null, minutesToFinish: null, estimatedFinish: null,
      status: 'not_started', pace: null, minutesSinceLastHole: null,
    };
  }

  const started = Date.parse(input.firstSubmittedAt);
  const last = input.lastSubmittedAt ? Date.parse(input.lastSubmittedAt) : started;
  const elapsedMin = (now.getTime() - started) / 60000;
  const perHole = minutesPerHole(holesCompleted, elapsedMin);
  const sinceLast = (now.getTime() - last) / 60000;

  if (holesCompleted >= totalHoles) {
    return {
      ...base, holesRemaining: 0, currentHole: null,
      minutesPerHole: perHole, minutesToFinish: 0,
      estimatedFinish: new Date(last).toISOString(),
      status: 'finished', pace: null, minutesSinceLastHole: sinceLast,
    };
  }

  const holesRemaining = totalHoles - holesCompleted;
  const minutesToFinish = perHole != null ? holesRemaining * perHole : null;
  return {
    ...base,
    minutesPerHole: perHole,
    minutesToFinish,
    estimatedFinish: minutesToFinish != null ? new Date(now.getTime() + minutesToFinish * 60000).toISOString() : null,
    status: 'playing',
    pace: paceFromField(holesCompleted, fieldMaxThru),
    minutesSinceLastHole: sinceLast,
  };
}

export interface FieldPace {
  teams: TeamPace[];
  playing: number;
  finished: number;
  notStarted: number;
  fieldMaxThru: number;
  // The LAST group in — this is what the kitchen cares about.
  lastFinishIso: string | null;
  minutesUntilLastFinish: number | null;
  holesInPlay: number[]; // holes with a group on them right now, ascending
}

export function computeFieldPace(inputs: TeamPaceInput[], now: Date, totalHoles = DEFAULT_HOLES): FieldPace {
  const fieldMaxThru = inputs.reduce((m, t) => Math.max(m, t.holesCompleted), 0);
  const teams = inputs.map((t) => computeTeamPace(t, now, fieldMaxThru, totalHoles));

  const playing = teams.filter((t) => t.status === 'playing');
  const withEta = playing.filter((t) => t.minutesToFinish != null);
  const lastMinutes = withEta.length ? Math.max(...withEta.map((t) => t.minutesToFinish!)) : null;

  const holesInPlay = [...new Set(playing.map((t) => t.currentHole).filter((h): h is number => h != null))].sort((a, b) => a - b);

  return {
    teams,
    playing: playing.length,
    finished: teams.filter((t) => t.status === 'finished').length,
    notStarted: teams.filter((t) => t.status === 'not_started').length,
    fieldMaxThru,
    lastFinishIso: lastMinutes != null ? new Date(now.getTime() + lastMinutes * 60000).toISOString() : null,
    minutesUntilLastFinish: lastMinutes,
    holesInPlay,
  };
}

// Should the kitchen be told now? True once the last group is within the lead
// time AND still actually out there. Callers must ALSO check that no
// notification has already been sent for this tournament — this function is
// deliberately stateless.
export function shouldNotifyKitchen(field: FieldPace, leadMinutes = KITCHEN_LEAD_MINUTES): boolean {
  if (field.playing === 0) return false;               // nobody left to finish
  if (field.minutesUntilLastFinish == null) return false;
  return field.minutesUntilLastFinish <= leadMinutes;
}

// The exact message the kitchen receives. Spec'd wording — a chef reading this
// on a phone needs the event, the timing, and where the groups are.
export function kitchenMessage(tournamentName: string, field: FieldPace, leadMinutes = KITCHEN_LEAD_MINUTES): string {
  const mins = field.minutesUntilLastFinish != null ? Math.max(1, Math.round(field.minutesUntilLastFinish)) : leadMinutes;
  const holes = field.holesInPlay.length ? field.holesInPlay.join(', ') : 'none';
  return `TourneyCoach: ${tournamentName} estimated finish in ${mins} minutes. Groups on holes ${holes}.`;
}
