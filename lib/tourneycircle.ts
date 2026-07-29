// Pure TourneyCircle logic — no I/O. Reach/cost/click-through math and
// radius matching for Module 22. Kept side-effect-free for unit testing.
import { haversineMeters, type LatLng } from './gps/geo';

export const NOTIFICATION_COST_CENTS = 2900; // $29 flat, one blast to all matched
export const RADIUS_OPTIONS = [15, 25, 35, 50] as const;

// Addressable-audience estimate by radius — the charitable-golfer reach around a
// course. Ported from the original in-coach TourneyCircle preview; shown as the
// projected reach until this course accumulates its own real opt-ins.
export const PREVIEW_RADIUS_COUNTS: Record<number, number> = { 15: 184, 25: 347, 35: 521, 50: 789 };

// Split a total into member types using the observed mix (individual / corporate
// / Circle-of-Excellence). For 347 → 285 / 62 / 41, matching the source data.
export function previewBreakdown(total: number): { total: number; individual: number; corporate: number; coe: number } {
  const individual = Math.round(total * 0.821);
  return { total, individual, corporate: total - individual, coe: Math.round(total * 0.118) };
}
export type RadiusMiles = (typeof RADIUS_OPTIONS)[number];
export type MemberType = 'individual' | 'corporate' | 'coe';

const MILES_TO_METERS = 1609.344;
export const milesToMeters = (mi: number): number => mi * MILES_TO_METERS;

export function isValidRadius(v: unknown): v is RadiusMiles {
  return typeof v === 'number' && (RADIUS_OPTIONS as readonly number[]).includes(v);
}

// About 1 in 4 matched players click through (spec + observed). Floor so we
// never over-promise; a 0 count yields 0.
export function expectedClicks(matched: number): number {
  return Math.floor(Math.max(0, matched) * 0.25);
}

export function dollars(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

// Average a set of coordinates into a single reference point (a course's
// centroid from its GPS-mapped positions). Returns null when there are none.
export function centroidOf(points: LatLng[]): LatLng | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!valid.length) return null;
  return {
    lat: valid.reduce((s, p) => s + p.lat, 0) / valid.length,
    lng: valid.reduce((s, p) => s + p.lng, 0) / valid.length,
  };
}

// ── Disclosure control ──────────────────────────────────────────────────────
// Aggregate counts are only private if they're big enough to hide inside. A
// bucket of 1 IS an individual, and an organizer who can vary radius or read a
// cause breakdown can difference two buckets to isolate one person — so any
// bucket below this threshold is reported as "suppressed" rather than as a
// number. This is what makes "counts only" actually mean "not individual data".
export const MIN_DISCLOSABLE_COUNT = 5;

export type DisclosedCount = { value: number; suppressed: boolean };

export function disclose(count: number): DisclosedCount {
  return count < MIN_DISCLOSABLE_COUNT
    ? { value: 0, suppressed: true }
    : { value: count, suppressed: false };
}

// Nested (cumulative) counts need more than a per-bucket floor. Radii are
// concentric, so two individually-safe totals can be SUBTRACTED to expose the
// ring between them: 15mi=6 and 25mi=7 both clear the floor, yet the difference
// reveals exactly one person. So a rung is only disclosed when its increment
// over the last disclosed rung is itself either zero (reveals nobody new) or at
// or above the floor. Input must be ascending by radius.
export function discloseLadder(counts: number[]): DisclosedCount[] {
  let lastDisclosed = 0;
  return counts.map((raw) => {
    const increment = raw - lastDisclosed;
    const safe = raw >= MIN_DISCLOSABLE_COUNT && (increment === 0 || increment >= MIN_DISCLOSABLE_COUNT);
    if (!safe) return { value: 0, suppressed: true };
    lastDisclosed = raw;
    return { value: raw, suppressed: false };
  });
}

// The organizer-facing cause breakdown. Cause preferences are free-form tags a
// player picks, so a rare one ("junior hockey in Mandeville") can be as
// identifying as a name — every bucket goes through the same threshold, and
// anything under it is folded into "other" rather than listed.
export function causeBreakdown(
  members: { cause_preferences?: string[] | null }[],
): { cause: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const m of members) {
    for (const c of m.cause_preferences ?? []) {
      const key = c.trim().toLowerCase();
      if (key) tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const rows: { cause: string; count: number }[] = [];
  let other = 0;
  for (const [cause, count] of tally) {
    if (count < MIN_DISCLOSABLE_COUNT) other += count;
    else rows.push({ cause, count });
  }
  rows.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
  // "Other" is a sum across several rare causes, so it doesn't identify anyone
  // on its own — but it still gets the threshold, or a lone rare cause would
  // simply reappear under a different label.
  if (other >= MIN_DISCLOSABLE_COUNT) rows.push({ cause: 'other', count: other });
  return rows;
}

export type Member = { home_lat: number | null; home_lng: number | null; member_type: MemberType };

// Aggregate the matched-player counts within a radius of the reference point.
// Members with no home location can't be matched and are excluded. Returns only
// counts — the caller (organizer) never receives individual rows.
export function countWithinRadius(
  members: Member[],
  reference: LatLng | null,
  radiusMiles: number,
): { total: number; individual: number; corporate: number; coe: number } {
  const out = { total: 0, individual: 0, corporate: 0, coe: 0 };
  if (!reference) return out;
  const limit = milesToMeters(radiusMiles);
  for (const m of members) {
    if (m.home_lat == null || m.home_lng == null) continue;
    if (haversineMeters({ lat: m.home_lat, lng: m.home_lng }, reference) > limit) continue;
    out.total++;
    out[m.member_type]++;
  }
  return out;
}

// Members inside a radius — used server-side to derive further aggregates
// (cause mix). Never returned to an organizer; only counts derived from it are.
export function membersWithinRadius<T extends Member>(
  members: T[],
  reference: LatLng | null,
  radiusMiles: number,
): T[] {
  if (!reference) return [];
  const limit = milesToMeters(radiusMiles);
  return members.filter(
    (m) => m.home_lat != null && m.home_lng != null
      && haversineMeters({ lat: m.home_lat, lng: m.home_lng }, reference) <= limit,
  );
}
