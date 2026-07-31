// Vendor donation engine — categories, and the ask each one gets.
//
// The connective tissue of Day 28: a donation ask is only persuasive when it
// is specific, and the specific number comes from the F&B calculator. "Would
// you consider supporting our tournament?" is a fundraising email. "We need
// 10 cases of beer for 72 players on October 10th" is a request a distributor
// can say yes to in one reply, because it maps to a pallet in their warehouse.
//
// So `askFor` takes the computed plan and returns the concrete quantity for
// that vendor type. If the plan is missing we degrade to a qualitative ask
// rather than inventing a number.

import { pluralUnit, type FbPlan, type ConsumableKey } from '@/lib/fb/calculator';

export type VendorCategory =
  | 'beer_wine_distributor'
  | 'food_supplier'
  | 'liquor_store'
  | 'restaurant'
  | 'coffee_shop'
  | 'hole_in_one_insurance';

export interface VendorCategoryMeta {
  key: VendorCategory;
  label: string;
  /** Two-word label for the compact roster row. */
  short: string;
  /** Row glyph. Carries category at a glance without a second column. */
  emoji: string;
  /** What this vendor is being asked to cover. */
  covers: string;
  /** How many to line up. Donation outreach converts poorly; one prospect is not a plan. */
  suggestedProspects: number;
  /** Which calculator lines this vendor supplies, for the UI to cross-reference. */
  supplies: ConsumableKey[];
}

// suggestedProspects reflects roughly how these convert in practice: a
// distributor with a community-giving budget says yes far more often than a
// restaurant being asked to cover 89 covers at cost.
export const VENDOR_CATEGORIES: VendorCategoryMeta[] = [
  { key: 'beer_wine_distributor', label: 'Beer & wine distributors', short: 'Beer', emoji: '\u{1F37A}',
    covers: 'On-course beer and wine', suggestedProspects: 3, supplies: ['beer'] },
  { key: 'liquor_store', label: 'Liquor stores', short: 'Liquor', emoji: '\u{1F943}',
    covers: 'Beer, wine, and spirits for the awards reception', suggestedProspects: 3, supplies: ['beer'] },
  { key: 'food_supplier', label: 'Food suppliers & distributors', short: 'Snacks', emoji: '\u{1F968}',
    covers: 'Snacks and awards lunch ingredients', suggestedProspects: 4, supplies: ['snacks'] },
  { key: 'restaurant', label: 'Restaurants & caterers', short: 'Lunch', emoji: '\u{1F354}',
    covers: 'The awards lunch', suggestedProspects: 4, supplies: [] },
  { key: 'coffee_shop', label: 'Coffee shops & roasters', short: 'Coffee', emoji: '\u2615',
    covers: 'Morning coffee at registration', suggestedProspects: 2, supplies: [] },
  { key: 'hole_in_one_insurance', label: 'Hole-in-one insurance', short: 'Hole-in-one', emoji: '\u26F3',
    covers: 'The hole-in-one prize policy', suggestedProspects: 2, supplies: [] },
];

export const VENDOR_CATEGORY_KEYS = VENDOR_CATEGORIES.map((c) => c.key);

export const categoryMeta = (key: string): VendorCategoryMeta | null =>
  VENDOR_CATEGORIES.find((c) => c.key === key) ?? null;

const packs = (plan: FbPlan, key: ConsumableKey) => plan.lines.find((l) => l.key === key);

const plural = (n: number, unit: string) => `${n} ${pluralUnit(unit, n)}`;

/**
 * The concrete ask for a vendor category, drawn from the F&B plan.
 * Returns null when there is no plan yet — the caller then asks qualitatively
 * rather than making a number up.
 */
export function askFor(category: VendorCategory, plan: FbPlan | null): string | null {
  if (!plan) return null;
  const players = plan.inputs.playerCount;

  switch (category) {
    case 'beer_wine_distributor':
    case 'liquor_store': {
      const beer = packs(plan, 'beer');
      if (!beer || beer.packs === 0) return null;
      return `${plural(beer.packs, beer.packUnit)} of beer (${beer.packedUnits} cans) for ${players} players`;
    }
    case 'food_supplier': {
      const snacks = packs(plan, 'snacks');
      const bits: string[] = [];
      if (snacks && snacks.packs > 0) bits.push(`${plural(snacks.packs, snacks.packUnit)} of on-course snacks (${snacks.packedUnits} servings)`);
      if (plan.lunch.portions > 0) bits.push(`ingredients for an awards lunch for ${plan.lunch.portions}`);
      return bits.length ? bits.join(', and ') : null;
    }
    case 'restaurant': {
      if (plan.lunch.portions <= 0) return null;
      const veg = plan.lunch.vegetarianPortions > 0
        ? ` (${plan.lunch.vegetarianPortions} of them vegetarian)` : '';
      const menu = plan.lunch.menu.length ? ` — we're planning ${plan.lunch.menu.join(', ')}` : '';
      return `an awards lunch for ${plan.lunch.portions} people${veg}${menu}`;
    }
    case 'coffee_shop': {
      const heads = plan.lunch.attendees;
      if (heads <= 0) return null;
      return `morning coffee service for ${heads} at registration`;
    }
    case 'hole_in_one_insurance':
      return `a hole-in-one prize policy for a ${players}-player shotgun`;
    default:
      return null;
  }
}

/**
 * Which categories still have no committed vendor, given what's been secured.
 * This is what makes the prospect list actionable instead of decorative.
 */
export function uncoveredCategories(
  committed: { category: string | null }[],
): VendorCategoryMeta[] {
  const done = new Set(committed.map((c) => c.category).filter(Boolean));
  return VENDOR_CATEGORIES.filter((c) => !done.has(c.key));
}
