// Day 19 hazard inference core — PURE functions (no database). The patent's
// plain-terms claim: "after 10-20 tournaments → hazard boundaries from
// avoidance patterns." Golfers' tracks flow around water/bunkers/waste
// areas; regions INSIDE the playing corridor that tracks conspicuously
// avoid are probable hazards.
//
// Method (grid-based avoidance detection):
//   1. Lay a square grid (GRID_M meters) over the hole's corridor, defined
//      by the aggregated tee→green axis padded by CORRIDOR_HALF_WIDTH_M.
//   2. Count distinct-round visits per cell (a round revisiting a cell
//      doesn't double-count — independence again).
//   3. A cell is a hazard candidate when it is (a) inside the corridor,
//      (b) essentially unvisited, and (c) surrounded by well-traveled
//      cells — emptiness AT THE EDGE of play is just rough; emptiness
//      SURROUNDED by play is something golfers steer around.
//   4. Adjacent candidate cells merge into hazard regions; tiny regions
//      (< MIN_REGION_CELLS) are noise and dropped.
//
// Confidence for a region reuses the tournament-count model from
// aggregateCore: the more independent rounds that flowed around a region
// without entering it, the more certain the avoidance is deliberate.
import { haversineMeters, type LatLng } from './geo';
import { confidenceScore } from './aggregateCore';

export interface RoundTrack {
  roundId: string;        // one player-round (device+tournament)
  tournamentId: string;
  points: LatLng[];
}

export interface HazardRegion {
  center: LatLng;
  cells: LatLng[];        // centers of member cells
  approxRadiusM: number;
  confidence: number;
  avoidingRounds: number; // rounds passing adjacent without entering
}

export const GRID_M = 15;                 // cell edge — bunker-scale resolution
export const CORRIDOR_HALF_WIDTH_M = 60;  // playable corridor half-width around the tee→green axis
export const MIN_NEIGHBOR_VISITS = 3;     // rounds in surrounding cells for "surrounded by play"
// Real avoided regions (water, waste areas, large bunker complexes) are
// contiguous and multi-cell. Random sparse gaps in even coverage are small,
// so requiring 4+ contiguous avoided cells rejects them as noise — the
// trade-off is that a lone pot bunker (~1 cell) won't surface from avoidance
// alone, which is acceptable for "hazard boundaries" (regions, not points).
export const MIN_REGION_CELLS = 4;
const M_PER_DEG_LAT = 111_320;

export function inferHazards(tee: LatLng, green: LatLng, rounds: RoundTrack[]): HazardRegion[] {
  if (rounds.length === 0) return [];
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((tee.lat * Math.PI) / 180);
  const toCell = (p: LatLng) => ({
    i: Math.floor(((p.lat - tee.lat) * M_PER_DEG_LAT) / GRID_M),
    j: Math.floor(((p.lng - tee.lng) * mPerDegLng) / GRID_M),
  });
  const cellCenter = (i: number, j: number): LatLng => ({
    lat: tee.lat + ((i + 0.5) * GRID_M) / M_PER_DEG_LAT,
    lng: tee.lng + ((j + 0.5) * GRID_M) / mPerDegLng,
  });
  const key = (i: number, j: number) => `${i}:${j}`;

  // Distinct rounds visiting each cell.
  const visits = new Map<string, Set<string>>();
  for (const round of rounds) {
    for (const p of round.points) {
      const { i, j } = toCell(p);
      const k = key(i, j);
      if (!visits.has(k)) visits.set(k, new Set());
      visits.get(k)!.add(round.roundId);
    }
  }

  // Corridor = cells within CORRIDOR_HALF_WIDTH_M of the tee→green segment.
  const holeLenM = haversineMeters(tee, green);
  const steps = Math.max(1, Math.ceil(holeLenM / GRID_M));
  const corridor = new Set<string>();
  const cellsPerHalfWidth = Math.ceil(CORRIDOR_HALF_WIDTH_M / GRID_M);
  for (let s = 0; s <= steps; s++) {
    const along: LatLng = {
      lat: tee.lat + ((green.lat - tee.lat) * s) / steps,
      lng: tee.lng + ((green.lng - tee.lng) * s) / steps,
    };
    const c = toCell(along);
    for (let di = -cellsPerHalfWidth; di <= cellsPerHalfWidth; di++) {
      for (let dj = -cellsPerHalfWidth; dj <= cellsPerHalfWidth; dj++) {
        corridor.add(key(c.i + di, c.j + dj));
      }
    }
  }

  // Hazard candidates: unvisited corridor cells that are BRACKETED by play —
  // traffic on opposite sides (left AND right, or short AND long, or a
  // diagonal pair). This is what separates an interior avoided pocket (a
  // hazard golfers steer around) from the corridor's outer edge (rough,
  // which only ever has traffic on its inner side). An edge fails the
  // bracket test; a hazard passes.
  const candidates = new Map<string, { i: number; j: number; neighborRounds: Set<string> }>();
  for (const k of corridor) {
    const visited = visits.get(k)?.size ?? 0;
    if (visited > 0) continue;
    const [i, j] = k.split(':').map(Number);
    const played = (di: number, dj: number) => (visits.get(key(i + di, j + dj))?.size ?? 0) > 0;
    const bracketed =
      (played(0, -1) && played(0, 1)) ||
      (played(-1, 0) && played(1, 0)) ||
      (played(-1, -1) && played(1, 1)) ||
      (played(-1, 1) && played(1, -1));
    if (!bracketed) continue;

    const neighborRounds = new Set<string>();
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (di === 0 && dj === 0) continue;
        for (const r of visits.get(key(i + di, j + dj)) ?? []) neighborRounds.add(r);
      }
    }
    if (neighborRounds.size >= MIN_NEIGHBOR_VISITS) {
      candidates.set(k, { i, j, neighborRounds });
    }
  }

  // Merge adjacent candidates into regions (flood fill).
  const seen = new Set<string>();
  const regions: HazardRegion[] = [];
  const roundToTournament = new Map(rounds.map((r) => [r.roundId, r.tournamentId]));
  for (const [startKey, start] of candidates) {
    if (seen.has(startKey)) continue;
    const queue = [start];
    seen.add(startKey);
    const member: { i: number; j: number }[] = [];
    const avoiding = new Set<string>();
    while (queue.length) {
      const cur = queue.pop()!;
      member.push(cur);
      for (const r of cur.neighborRounds) avoiding.add(r);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const nk = key(cur.i + di, cur.j + dj);
          const n = candidates.get(nk);
          if (n && !seen.has(nk)) { seen.add(nk); queue.push(n); }
        }
      }
    }
    if (member.length < MIN_REGION_CELLS) continue;

    const centers = member.map((m) => cellCenter(m.i, m.j));
    // Represent the region by the member cell NEAREST the tee→green axis —
    // the fairway-facing edge golfers actually skirt. The unweighted centroid
    // sits deeper in the avoidance "shadow" behind the hazard, which
    // over-estimates the hazard's distance from the line of play.
    const axisLat = green.lat - tee.lat;
    const axisLng = green.lng - tee.lng;
    const axisLenSq = axisLat * axisLat + axisLng * axisLng || 1;
    const perpDist = (p: LatLng) => {
      const t = ((p.lat - tee.lat) * axisLat + (p.lng - tee.lng) * axisLng) / axisLenSq;
      const proj = { lat: tee.lat + axisLat * t, lng: tee.lng + axisLng * t };
      return haversineMeters(p, proj);
    };
    const center = centers.reduce((best, c) => (perpDist(c) < perpDist(best) ? c : best));
    const tournaments = new Set([...avoiding].map((r) => roundToTournament.get(r) ?? 'unknown')).size;
    regions.push({
      center,
      cells: centers,
      approxRadiusM: Math.round(Math.sqrt(member.length) * GRID_M * 0.6),
      // Spread 0 → agreement factor 1: avoidance evidence has no positional
      // disagreement analog, so confidence rides purely on tournament count.
      confidence: confidenceScore(tournaments, 0),
      avoidingRounds: avoiding.size,
    });
  }
  return regions.sort((a, b) => b.confidence - a.confidence);
}
