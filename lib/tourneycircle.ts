// Pure TourneyCircle logic — no I/O. Reach/cost/click-through math and
// radius matching for Module 22. Kept side-effect-free for unit testing.
import { haversineMeters, type LatLng } from './gps/geo';

export const NOTIFICATION_COST_CENTS = 2900; // $29 flat, one blast to all matched
export const RADIUS_OPTIONS = [15, 25, 35, 50] as const;
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
