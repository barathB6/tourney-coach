// Weather-adjusted F&B quantity calculator.
//
// The model is deliberately explicit rather than a single fudge factor: every
// number below is a lever an organizer can defend to a board, and every one of
// them is stored on the plan so a calculation reproduces exactly even after we
// tune the shipped defaults.
//
// Shape of the model, per consumable:
//
//   units = players × basePerPlayer × roundLength × heat^elasticity × rain
//
// Heat is one curve for the whole event; elasticity is what differs per item.
// Water and sports drinks track temperature almost fully. Beer barely does —
// beer consumption at a scramble is driven by the social occasion, not by
// thermoregulation, and past about 90°F it actually starts losing share to
// water. Snacks move *against* heat: people eat less in the sun.
//
// A note on what this is NOT: it is not a substitute for what the course's
// own F&B manager knows about their event. It is a defensible starting order
// with the reasoning shown, so an organizer can argue with it.

import { ASSUMED_MIN_PER_HOLE, KITCHEN_LEAD_MINUTES } from '@/lib/pace';

export type ConsumableKey = 'beer' | 'water' | 'soft_drinks' | 'sports_drinks' | 'snacks';

export const CONSUMABLE_LABELS: Record<ConsumableKey, string> = {
  beer: 'Beer',
  water: 'Water',
  soft_drinks: 'Soft drinks',
  sports_drinks: 'Sports drinks',
  snacks: 'Snacks',
};

// Per player, for a full 18-hole round at the 75°F baseline.
// Water matches beer deliberately. An earlier draft had it at 2.5 against
// beer's 3.0, which tripped the responsible-service check below on any warm
// day — the check was right and the default was wrong. One bottle per 90
// minutes of a 4-hour round is not generous, it's the minimum.
export const DEFAULT_BASELINES: Record<ConsumableKey, number> = {
  beer: 3.0,
  water: 3.0,
  soft_drinks: 1.0,
  sports_drinks: 0.6,
  snacks: 1.5,
};

// Flags a plan the organizer has edited upward, not the shipped default.
export const BEER_PER_PLAYER_ADVISORY = 3.5;

// How hard each item responds to the heat multiplier. 1.0 = tracks temperature
// fully; 0 = indifferent; negative = falls as it gets hotter.
export const HEAT_ELASTICITY: Record<ConsumableKey, number> = {
  beer: 0.45,
  water: 1.0,
  soft_drinks: 0.7,
  sports_drinks: 1.3,
  snacks: -0.25,
};

// How the item is actually bought. "224 beers" is not an order; "10 cases" is.
export const PACK_SIZE: Record<ConsumableKey, { size: number; unit: string }> = {
  beer: { size: 24, unit: 'case' },
  water: { size: 24, unit: 'case' },
  soft_drinks: { size: 24, unit: 'case' },
  sports_drinks: { size: 12, unit: '12-pack' },
  snacks: { size: 12, unit: 'box' },
};

/** "box" → "boxes", "case" → "cases". Sibilants take -es. */
// Re-exported: this now lives in lib/plural.ts so the rest of the app can
// reach it without importing the F&B calculator.
export { plural as pluralUnit } from '@/lib/plural';

// Consumption vs temperature, anchored and linearly interpolated. Anchors
// rather than buckets so that 79°F and 80°F don't differ by 35%.
const HEAT_CURVE: [number, number][] = [
  [45, 0.66],
  [55, 0.75],
  [65, 0.86],
  [75, 1.00], // baseline
  [85, 1.25],
  [95, 1.55],
  [105, 1.85],
];

export const BASELINE_TEMP_F = 75;

/** Whole-event consumption multiplier for a temperature, clamped at both ends. */
export function heatMultiplier(tempF: number): number {
  const first = HEAT_CURVE[0];
  const last = HEAT_CURVE[HEAT_CURVE.length - 1];
  if (tempF <= first[0]) return first[1];
  if (tempF >= last[0]) return last[1];
  for (let i = 0; i < HEAT_CURVE.length - 1; i++) {
    const [t0, m0] = HEAT_CURVE[i];
    const [t1, m1] = HEAT_CURVE[i + 1];
    if (tempF >= t0 && tempF <= t1) {
      return m0 + ((tempF - t0) / (t1 - t0)) * (m1 - m0);
    }
  }
  return 1;
}

// Rain suppresses on-course consumption — shorter rounds, cart-path-only, and
// some groups simply leave. We apply it, but gently and visibly: under-ordering
// a charity event is worse than over-ordering, since distributors generally
// take back unopened cases and beer keeps. Capped at a 15% reduction.
export const MAX_RAIN_REDUCTION = 0.15;

export function rainMultiplier(precipChance: number | null | undefined): number {
  if (precipChance == null || !Number.isFinite(precipChance)) return 1;
  const p = Math.min(100, Math.max(0, precipChance)) / 100;
  return 1 - MAX_RAIN_REDUCTION * p;
}

// Share of awards-lunch attendees to plan a vegetarian portion for. A default,
// not a claim — overridable per tournament.
export const DEFAULT_VEGETARIAN_SHARE = 0.12;
// Ordering over-run on plated portions. Running out of lunch at the awards
// ceremony is the failure everyone remembers.
export const LUNCH_OVERAGE = 1.05;

export interface FbInputs {
  playerCount: number;
  volunteerCount?: number;
  guestCount?: number;
  holes?: 9 | 18;
  temperatureF: number;
  precipChance?: number | null;
  /** Per-player baselines; omitted keys fall back to DEFAULT_BASELINES. */
  baselines?: Partial<Record<ConsumableKey, number>>;
  vegetarianShare?: number;
  /** Awards lunch menu items — names only; they drive prep timing and the vendor ask. */
  menu?: string[];
  /** ISO datetime of the shotgun start, for the kitchen timeline. */
  shotgunAt?: string | null;
}

export interface ConsumableLine {
  key: ConsumableKey;
  label: string;
  /** Individual servings, rounded up. */
  units: number;
  /** Ordering unit, e.g. 10 cases. */
  packs: number;
  packUnit: string;
  packSize: number;
  /** Servings actually delivered once rounded to whole packs. */
  packedUnits: number;
  perPlayer: number;
  basePerPlayer: number;
  /** The multiplier this item saw, after its own elasticity. */
  weatherFactor: number;
}

export interface LunchPlan {
  attendees: number;
  portions: number;
  vegetarianPortions: number;
  standardPortions: number;
  menu: string[];
}

export interface PrepStep {
  /** Minutes relative to the shotgun start; negative is before. */
  offsetMinutes: number;
  at: string | null;
  label: string;
  detail: string;
}

export interface FbPlan {
  inputs: Required<Pick<FbInputs, 'playerCount' | 'temperatureF'>> & {
    volunteerCount: number;
    guestCount: number;
    holes: number;
    precipChance: number | null;
  };
  heat: number;
  rain: number;
  lines: ConsumableLine[];
  lunch: LunchPlan;
  prep: PrepStep[];
  warnings: string[];
}

const clampInt = (n: unknown, min: number, max: number, fallback = 0) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(max, Math.max(min, v));
};

/**
 * Back-timed kitchen schedule. Everything hangs off the shotgun start and the
 * same pace assumption Module 9 uses to decide when to text the kitchen — if
 * the pace tracker and the F&B plan disagreed about how long a round takes,
 * one of them would be wrong on the day.
 */
export function buildPrepTimeline(
  holes: number,
  shotgunAt: string | null | undefined,
  menu: string[],
): PrepStep[] {
  const roundMinutes = holes * ASSUMED_MIN_PER_HOLE;
  const turnMinutes = Math.round(roundMinutes / 2);
  const lunchServe = roundMinutes + 20; // groups need a few minutes to come in

  const steps: Omit<PrepStep, 'at'>[] = [
    { offsetMinutes: -120, label: 'Ice the coolers, load beverage stock',
      detail: 'Two hours out. Cans need this long to come down to temperature.' },
    { offsetMinutes: -45, label: 'Beverage carts stocked and on course',
      detail: 'Carts should be in position before the first group reaches their tee.' },
    { offsetMinutes: 0, label: 'Shotgun start', detail: 'All groups tee off.' },
    { offsetMinutes: turnMinutes, label: 'Restock the turn station',
      detail: 'Roughly half the field has passed. This is where the first shortage shows up.' },
    { offsetMinutes: lunchServe - KITCHEN_LEAD_MINUTES, label: 'Kitchen fires the hot food',
      detail: menu.length
        ? `${KITCHEN_LEAD_MINUTES} minutes before service: ${menu.join(', ')}.`
        : `${KITCHEN_LEAD_MINUTES} minutes before service — the same lead time the pace tracker texts the kitchen with.` },
    { offsetMinutes: roundMinutes, label: 'Last group in',
      detail: `${holes} holes at ${ASSUMED_MIN_PER_HOLE} min/hole.` },
    { offsetMinutes: lunchServe, label: 'Awards lunch served', detail: 'Food on the table as the field sits down.' },
  ];

  const base = shotgunAt ? Date.parse(shotgunAt) : NaN;
  return steps.map((s) => ({
    ...s,
    at: Number.isNaN(base) ? null : new Date(base + s.offsetMinutes * 60_000).toISOString(),
  }));
}

export function calculateFb(input: FbInputs): FbPlan {
  const players = clampInt(input.playerCount, 0, 10_000);
  const volunteers = clampInt(input.volunteerCount, 0, 10_000);
  const guests = clampInt(input.guestCount, 0, 10_000);
  const holes = input.holes === 9 ? 9 : 18;
  const tempF = Number.isFinite(input.temperatureF) ? input.temperatureF : BASELINE_TEMP_F;
  const precip = input.precipChance == null || !Number.isFinite(input.precipChance)
    ? null : Math.min(100, Math.max(0, input.precipChance));

  const heat = heatMultiplier(tempF);
  const rain = rainMultiplier(precip);
  const roundLength = holes / 18;

  const lines: ConsumableLine[] = (Object.keys(DEFAULT_BASELINES) as ConsumableKey[]).map((key) => {
    const override = input.baselines?.[key];
    const basePerPlayer = typeof override === 'number' && Number.isFinite(override) && override >= 0
      ? override : DEFAULT_BASELINES[key];

    // Elasticity is applied to the *deviation* from 1, not as an exponent —
    // an item with elasticity 0.45 moves 45% as far from baseline as the
    // event's heat multiplier does. Negative elasticity moves the other way.
    const weatherFactor = 1 + (heat - 1) * HEAT_ELASTICITY[key];
    const raw = players * basePerPlayer * roundLength * weatherFactor * rain;
    const units = Math.ceil(raw);
    const { size, unit } = PACK_SIZE[key];
    const packs = Math.ceil(units / size);

    return {
      key,
      label: CONSUMABLE_LABELS[key],
      units,
      packs,
      packUnit: unit,
      packSize: size,
      packedUnits: packs * size,
      perPlayer: players > 0 ? units / players : 0,
      basePerPlayer,
      weatherFactor,
    };
  });

  const attendees = players + volunteers + guests;
  const portions = Math.ceil(attendees * LUNCH_OVERAGE);
  const vegShare = typeof input.vegetarianShare === 'number' && input.vegetarianShare >= 0 && input.vegetarianShare <= 1
    ? input.vegetarianShare : DEFAULT_VEGETARIAN_SHARE;
  const vegetarianPortions = Math.ceil(portions * vegShare);
  const menu = (input.menu ?? []).filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim());

  const lunch: LunchPlan = {
    attendees,
    portions,
    vegetarianPortions,
    standardPortions: portions - vegetarianPortions,
    menu,
  };

  const warnings: string[] = [];
  const beer = lines.find((l) => l.key === 'beer')!;
  const water = lines.find((l) => l.key === 'water')!;

  // Responsible service, surfaced rather than silently corrected — we don't
  // invent stock the organizer didn't plan, but they should see this.
  if (water.units < beer.units) {
    warnings.push(
      `Planned water (${water.units}) is below planned beer (${beer.units}). Most courses require at least as much water as alcohol on the carts.`,
    );
  }
  if (beer.perPlayer > BEER_PER_PLAYER_ADVISORY) {
    warnings.push(
      `That works out to ${beer.perPlayer.toFixed(1)} beers per player over ${(holes * ASSUMED_MIN_PER_HOLE / 60).toFixed(1)} hours. Worth a look before ordering.`,
    );
  }
  if (tempF >= 90) {
    warnings.push(`At ${Math.round(tempF)}°F, plan a water station at the turn as well as the carts, and brief the marshals on heat illness.`);
  }
  if (precip != null && precip >= 50) {
    warnings.push(`${Math.round(precip)}% chance of rain — quantities are reduced ${Math.round((1 - rain) * 100)}%. Confirm your distributor takes back unopened cases before trimming further.`);
  }
  if (players === 0) {
    warnings.push('No players counted yet, so every quantity is zero. Set a headcount to get a real plan.');
  }

  return {
    inputs: { playerCount: players, volunteerCount: volunteers, guestCount: guests, holes, temperatureF: tempF, precipChance: precip },
    heat,
    rain,
    lines,
    lunch,
    prep: buildPrepTimeline(holes, input.shotgunAt, menu),
    warnings,
  };
}
