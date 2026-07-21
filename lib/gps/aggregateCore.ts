// Day 19 aggregation core — PURE functions only (no database, no Supabase
// import). The DB glue lives in aggregate.ts; keeping the math dependency-
// free lets scripts/verify-gps-aggregation.ts drive it offline against
// synthetic multi-tournament data without touching production tables.
import { haversineMeters, centroid, type LatLng } from './geo';

// One derived detection event for a hole feature — e.g. a tee_box cluster
// from one tournament, a green label from one score submission, or a manual
// mark. Each event is an INDEPENDENT sample sequence in patent terms.
export interface FeatureSample extends LatLng {
  // How many device pings contributed to this event (cluster size etc.).
  sampleCount: number;
  // The per-event confidence recorded at detection time (0..1).
  eventConfidence: number;
  // Tournament this sample came from — samples from the same tournament are
  // NOT independent for confidence purposes.
  tournamentId: string | null;
}

export interface AggregatedFeature extends LatLng {
  confidence: number;
  contributingSamples: number;   // events that survived outlier rejection
  independentTournaments: number; // distinct tournaments among them
  spreadMeters: number;           // mean distance of surviving events to the aggregate
}

// Reject events farther than this from the preliminary centroid — a wrong
// hole tag or a parking-lot fix shouldn't drag a green 80m. Golf features
// (tee pads, greens) are tens of meters across, so 40m of slack tolerates
// GPS noise while excluding gross outliers.
export const OUTLIER_RADIUS_M = 40;

// ── Confidence model (FOUNDER REVIEW ITEM) ──────────────────────────────────
// Confidence is driven by the number of INDEPENDENT sample sequences, where
// independence means "different tournament" (two clusters in the same round
// share weather, pin sheet, and crowd, so they corroborate weakly).
//
//   confidence(T, agreement) = (T / (T + K)) * agreement
//
//   T          = distinct tournaments contributing surviving samples
//   K = 1.8    = half-saturation constant, tuned so the filing's "after 3-5
//                tournaments → accurate positions" milestone crosses the
//                verified line at T=5: a tightly-agreeing feature scores
//                1→0.34, 2→0.51, 3→0.60, 5→0.71, 10→0.82, asymptote 1.0.
//   agreement  = spatial-agreement factor: 1.0 when surviving events sit
//                within GPS noise of each other, decaying linearly to 0.5 as
//                mean spread approaches OUTLIER_RADIUS_M. Many tournaments
//                that disagree should NOT read as high confidence.
//
// VERIFIED_THRESHOLD is what downstream UIs use for the "verified" badge.
export const CONFIDENCE_HALF_SATURATION_K = 1.8;
export const VERIFIED_THRESHOLD = 0.7;

export function confidenceScore(independentTournaments: number, spreadMeters: number): number {
  if (independentTournaments <= 0) return 0;
  const base = independentTournaments / (independentTournaments + CONFIDENCE_HALF_SATURATION_K);
  const agreement = 1 - 0.5 * Math.min(1, spreadMeters / OUTLIER_RADIUS_M);
  return Math.round(base * agreement * 100) / 100;
}

// Aggregate one hole-feature's detection events (across tournaments) into a
// single canonical position + confidence.
//
// Weighting: each event counts by its ping count (a 4-phone cluster is worth
// more than a 1-phone manual mark), capped at 4 so one anomalous mega-event
// can't dominate.
export function aggregateFeature(samples: FeatureSample[]): AggregatedFeature | null {
  if (samples.length === 0) return null;

  // Component-wise MEDIAN as the outlier reference — robust to a single far
  // event (a wrong-hole tag or parking-lot fix) that would otherwise drag a
  // mean centroid ~40m and cause good events to fall outside the radius too.
  const ref = componentMedian(samples);
  const surviving = samples.filter((s) => haversineMeters(s, ref) <= OUTLIER_RADIUS_M);
  // Everything an outlier relative to each other (bimodal data): fall back to
  // the largest cluster around the single sample nearest the most neighbors.
  const kept = surviving.length > 0 ? surviving : [nearestToPeers(samples)];

  let wSum = 0, latSum = 0, lngSum = 0;
  for (const s of kept) {
    const w = Math.min(4, Math.max(1, s.sampleCount));
    wSum += w;
    latSum += s.lat * w;
    lngSum += s.lng * w;
  }
  const agg: LatLng = { lat: latSum / wSum, lng: lngSum / wSum };

  const spread = kept.reduce((sum, s) => sum + haversineMeters(s, agg), 0) / kept.length;
  const tournaments = new Set(kept.map((s) => s.tournamentId ?? 'unknown')).size;

  return {
    ...agg,
    confidence: confidenceScore(tournaments, spread),
    contributingSamples: kept.length,
    independentTournaments: tournaments,
    spreadMeters: Math.round(spread * 10) / 10,
  };
}

// ── Fairway routing aggregation ─────────────────────────────────────────────
// "Average fairway routing samples": each round's track is projected onto
// the tee→green axis, bucketed into WAYPOINT_BINS fractions of the hole,
// averaged per-round per-bin first (so a round that lingered somewhere
// doesn't outvote others), then across rounds. The result is a polyline of
// typical play — the GPS-derived fairway.
export const WAYPOINT_BINS = 10;

export interface FairwayRoute {
  waypoints: LatLng[];            // ordered tee → green
  independentTournaments: number;
  contributingRounds: number;
  confidence: number;
}

export function aggregateFairway(
  tee: LatLng,
  green: LatLng,
  rounds: { roundId: string; tournamentId: string; points: LatLng[] }[],
): FairwayRoute | null {
  const usable = rounds.filter((r) => r.points.length >= 3);
  if (usable.length === 0) return null;

  const axisLat = green.lat - tee.lat;
  const axisLng = green.lng - tee.lng;
  const axisLenSq = axisLat * axisLat + axisLng * axisLng;
  if (axisLenSq === 0) return null;
  const fractionAlong = (p: LatLng) =>
    ((p.lat - tee.lat) * axisLat + (p.lng - tee.lng) * axisLng) / axisLenSq;

  // per-round per-bin means
  const perRoundBins: (LatLng | null)[][] = usable.map((r) => {
    const bins: { lat: number; lng: number; n: number }[] = Array.from({ length: WAYPOINT_BINS }, () => ({ lat: 0, lng: 0, n: 0 }));
    for (const p of r.points) {
      const t = fractionAlong(p);
      if (t < 0 || t > 1) continue; // behind the tee / past the green
      const b = Math.min(WAYPOINT_BINS - 1, Math.floor(t * WAYPOINT_BINS));
      bins[b].lat += p.lat; bins[b].lng += p.lng; bins[b].n += 1;
    }
    return bins.map((b) => (b.n > 0 ? { lat: b.lat / b.n, lng: b.lng / b.n } : null));
  });

  // across-round means per bin (skip bins nobody sampled)
  const waypoints: LatLng[] = [];
  for (let b = 0; b < WAYPOINT_BINS; b++) {
    let lat = 0, lng = 0, n = 0;
    for (const bins of perRoundBins) {
      const v = bins[b];
      if (v) { lat += v.lat; lng += v.lng; n += 1; }
    }
    if (n > 0) waypoints.push({ lat: lat / n, lng: lng / n });
  }
  if (waypoints.length < 2) return null;

  const tournaments = new Set(usable.map((r) => r.tournamentId)).size;
  return {
    waypoints,
    independentTournaments: tournaments,
    contributingRounds: usable.length,
    confidence: confidenceScore(tournaments, 0),
  };
}

function componentMedian(pts: LatLng[]): LatLng {
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return { lat: med(pts.map((p) => p.lat)), lng: med(pts.map((p) => p.lng)) };
}

function nearestToPeers(samples: FeatureSample[]): FeatureSample {
  let best = samples[0];
  let bestScore = Infinity;
  for (const s of samples) {
    const score = samples.reduce((sum, o) => sum + haversineMeters(s, o), 0);
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}
