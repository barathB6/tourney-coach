// Golf Pro Course Builder (Day 17): course profile completion + validation.
// Hole capacity/shotgun math lives in lib/shotgun.ts — this file only covers
// the course profile itself (hole data, tees, metadata).

export const TEES = ['black', 'blue', 'white', 'gold', 'red'] as const;
export type Tee = (typeof TEES)[number];

export const TEE_LABELS: Record<Tee, string> = {
  black: 'Championship',
  blue: 'Member back',
  white: 'Member regular',
  gold: 'Senior',
  red: 'Forward',
};

export interface CourseHole {
  holeNumber: number; // 1-based
  par: number | null;
  handicap: number | null;
  description: string | null;
  teeYardages: Partial<Record<Tee, number>>;
}

export function emptyHoles(): CourseHole[] {
  return Array.from({ length: 18 }, (_, i) => ({
    holeNumber: i + 1,
    par: null,
    handicap: null,
    description: null,
    teeYardages: {},
  }));
}

// A hole counts as "complete" once it has a par and at least one tee
// distance — that's the minimum a pro needs for the hole to be usable in a
// tournament. Handicap is tracked separately since some pros fill it in
// later from the course's official card.
export function isHoleComplete(hole: CourseHole): boolean {
  return hole.par != null && Object.keys(hole.teeYardages).length > 0;
}

export function completionCount(holes: CourseHole[]): number {
  return holes.filter(isHoleComplete).length;
}

export function parTotal(holes: CourseHole[]): number {
  return holes.reduce((sum, h) => sum + (h.par ?? 0), 0);
}

// Handicap stroke indexes (1-18) must each be used exactly once across the
// 18 holes for the card to be valid — this is what pace/handicap software
// downstream expects.
export function handicapConflicts(holes: CourseHole[]): number[] {
  const seen = new Map<number, number>();
  for (const h of holes) {
    if (h.handicap == null) continue;
    seen.set(h.handicap, (seen.get(h.handicap) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([hcp]) => hcp);
}

// Turns raw course_holes rows into the 18-element par array the Shotgun
// Start Manager (lib/shotgun.ts, tournaments.hole_pars) expects. Only
// returns an array when every hole 1-18 has a par set — a partially-built
// course profile shouldn't silently overwrite a tournament's par layout
// with nulls/gaps.
export function holeParsFromRows(rows: { hole_number: number; par: number | null }[]): number[] | null {
  const pars = new Array<number | null>(18).fill(null);
  for (const row of rows) {
    if (row.hole_number >= 1 && row.hole_number <= 18) pars[row.hole_number - 1] = row.par;
  }
  return pars.every((p): p is number => p != null) ? pars : null;
}
