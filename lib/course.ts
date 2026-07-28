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

// Most common tee yardages for a hole of a given par, by tee — lets the
// Course Builder prefill sensible defaults the moment a pro sets a hole's
// par, instead of a blank yardage row for every tee.
export const AVG_PAR_YARDAGES: Record<3 | 4 | 5, Record<Tee, number>> = {
  3: { black: 185, blue: 165, white: 145, gold: 125, red: 105 },
  4: { black: 420, blue: 385, white: 355, gold: 320, red: 280 },
  5: { black: 560, blue: 520, white: 480, gold: 440, red: 400 },
};

// Canonical hole shape/feature vocabulary — replaces free-text hole
// descriptions with a fixed set of chips so both the pro's input and the
// illustrative hole-map schematic can be driven off the same structured
// data. Order here is the display order in the Course Builder.
export const HOLE_SHAPE_TAGS = [
  'straightaway',
  'dogleg_left',
  'dogleg_right',
  'double_dogleg',
  'blind_shot',
  'elevated_green',
  'waste_areas',
  'pot_bunkers',
  'fairway_bunkers',
  'sand_trap',
  'water_hazard',
] as const;
export type HoleShapeTag = (typeof HOLE_SHAPE_TAGS)[number];

export const HOLE_SHAPE_TAG_LABELS: Record<HoleShapeTag, string> = {
  straightaway: 'Straightaway',
  dogleg_left: 'Dogleg left',
  dogleg_right: 'Dogleg right',
  double_dogleg: 'Double dogleg',
  blind_shot: 'Blind shot',
  elevated_green: 'Elevated green',
  waste_areas: 'Waste areas',
  pot_bunkers: 'Pot bunkers',
  fairway_bunkers: 'Fairway bunkers',
  sand_trap: 'Sand trap',
  water_hazard: 'Water hazard',
};

// The description shown to players is auto-generated from the selected
// tags — a plain, consistent caption instead of pro-authored free text.
export function describeShapeTags(tags: string[]): string | null {
  const labels = tags
    .filter((t): t is HoleShapeTag => (HOLE_SHAPE_TAGS as readonly string[]).includes(t))
    .map((t) => HOLE_SHAPE_TAG_LABELS[t]);
  return labels.length ? labels.join(' · ') : null;
}

export interface CourseHole {
  holeNumber: number; // 1-based
  par: number | null;
  handicap: number | null;
  description: string | null;
  shapeTags: string[];
  teeYardages: Partial<Record<Tee, number>>;
}

export function emptyHoles(): CourseHole[] {
  return Array.from({ length: 18 }, (_, i) => ({
    holeNumber: i + 1,
    par: null,
    handicap: null,
    description: null,
    shapeTags: [],
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
