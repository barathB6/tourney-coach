// Day 19 verification harness — spec item: "Generate synthetic GPS data
// across multiple simulated tournaments at the same course" + verify
// aggregation accuracy, confidence scoring at various sample counts, and
// hazard inference on synthetic avoidance patterns.
//
// PURE + OFFLINE: drives the aggregateCore / hazardCore pure functions
// against ground truth. Writes NOTHING to the database. Run:
//   npx tsx scripts/verify-gps-aggregation.ts
//
// Deterministic: a seeded PRNG (no Math.random) so results are reproducible
// and CI-stable.
import { haversineMeters, type LatLng } from '../lib/gps/geo';
import { aggregateFeature, aggregateFairway, confidenceScore, VERIFIED_THRESHOLD, type FeatureSample } from '../lib/gps/aggregateCore';
import { inferHazards, type RoundTrack } from '../lib/gps/hazardCore';

// ── seeded PRNG (mulberry32) ────────────────────────────────────────────────
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(20260721);
// Gaussian-ish jitter in meters → degrees, at a golf-course latitude (~36°).
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((36.57 * Math.PI) / 180);
function jitter(p: LatLng, sigmaM: number): LatLng {
  const g = () => (rng() + rng() + rng() + rng() - 2) * 0.5; // ~N(0,1)
  return { lat: p.lat + (g() * sigmaM) / M_PER_DEG_LAT, lng: p.lng + (g() * sigmaM) / M_PER_DEG_LNG };
}

// Ground truth: one Pebble-ish hole 2 (par 3).
const TRUE_TEE: LatLng = { lat: 36.56820, lng: -121.94970 };
const TRUE_GREEN: LatLng = { lat: 36.56690, lng: -121.94830 };

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const section = (t: string) => console.log(`\n${t}`);

// ── 1. Aggregation accuracy across tournaments ──────────────────────────────
section('1. Tee/green aggregation converges to ground truth as tournaments accrue');
for (const nT of [1, 3, 5, 10]) {
  const samples: FeatureSample[] = [];
  for (let t = 0; t < nT; t++) {
    // one tee cluster (4 phones) per tournament, GPS sigma ~6m
    const c = jitter(TRUE_TEE, 6);
    samples.push({ ...c, sampleCount: 4, eventConfidence: 1, tournamentId: `T${t}` });
  }
  const agg = aggregateFeature(samples)!;
  const errM = haversineMeters(agg, TRUE_TEE);
  ok(errM < 8, `${nT} tournaments → tee within 8m of truth`, `${errM.toFixed(1)}m, conf ${agg.confidence}`);
  ok(agg.independentTournaments === nT, `counts ${nT} independent tournaments`, `${agg.independentTournaments}`);
}

// ── 2. Outlier rejection ────────────────────────────────────────────────────
section('2. Outlier rejection (wrong-hole tag / parking-lot fix)');
{
  const good: FeatureSample[] = Array.from({ length: 4 }, (_, t) => ({ ...jitter(TRUE_TEE, 5), sampleCount: 4, eventConfidence: 1, tournamentId: `T${t}` }));
  const outlier: FeatureSample = { lat: TRUE_TEE.lat + 0.0015, lng: TRUE_TEE.lng + 0.0015, sampleCount: 4, eventConfidence: 1, tournamentId: 'Tbad' }; // ~200m away
  const agg = aggregateFeature([...good, outlier])!;
  const errM = haversineMeters(agg, TRUE_TEE);
  ok(errM < 8, 'outlier does not drag the aggregate', `${errM.toFixed(1)}m`);
  ok(agg.contributingSamples === 4, 'outlier excluded from contributing samples', `${agg.contributingSamples}/5 kept`);
}

// ── 3. Confidence scoring at various sample counts ──────────────────────────
section('3. Confidence scoring (FOUNDER threshold review)');
{
  const tight = 3; // meters
  const curve = [1, 2, 3, 5, 10].map((t) => [t, confidenceScore(t, tight)] as const);
  for (const [t, c] of curve) console.log(`    ${t} tournament(s): confidence ${c}`);
  ok(confidenceScore(1, tight) < confidenceScore(3, tight) && confidenceScore(3, tight) < confidenceScore(10, tight), 'monotonically increases with tournaments');
  ok(confidenceScore(5, tight) >= VERIFIED_THRESHOLD, `crosses verified threshold (${VERIFIED_THRESHOLD}) by ~5 tournaments`, `${confidenceScore(5, tight)}`);
  ok(confidenceScore(10, 3) > confidenceScore(10, 35), 'disagreement (wide spread) lowers confidence even with many tournaments', `${confidenceScore(10, 3)} vs ${confidenceScore(10, 35)}`);
  ok(confidenceScore(0, 3) === 0, 'zero tournaments → zero confidence');
}

// ── 4. Fairway routing ──────────────────────────────────────────────────────
section('4. Fairway routing aggregation');
{
  const rounds: RoundTrack[] = [];
  for (let t = 0; t < 6; t++) {
    for (let p = 0; p < 3; p++) { // 3 players/round
      const pts: LatLng[] = [];
      for (let s = 0; s <= 20; s++) {
        const f = s / 20;
        const on: LatLng = { lat: TRUE_TEE.lat + (TRUE_GREEN.lat - TRUE_TEE.lat) * f, lng: TRUE_TEE.lng + (TRUE_GREEN.lng - TRUE_TEE.lng) * f };
        pts.push(jitter(on, 7));
      }
      rounds.push({ roundId: `${t}-${p}`, tournamentId: `T${t}`, points: pts });
    }
  }
  const fw = aggregateFairway(TRUE_TEE, TRUE_GREEN, rounds)!;
  ok(fw.waypoints.length >= 8, 'produces a multi-waypoint route', `${fw.waypoints.length} waypoints`);
  const maxDev = Math.max(...fw.waypoints.map((w) => {
    // distance from w to the tee→green line
    const A = TRUE_GREEN.lat - TRUE_TEE.lat, B = TRUE_GREEN.lng - TRUE_TEE.lng;
    const t = ((w.lat - TRUE_TEE.lat) * A + (w.lng - TRUE_TEE.lng) * B) / (A * A + B * B);
    const proj = { lat: TRUE_TEE.lat + A * t, lng: TRUE_TEE.lng + B * t };
    return haversineMeters(w, proj);
  }));
  ok(maxDev < 10, 'route hugs the true tee→green axis (straight hole)', `max deviation ${maxDev.toFixed(1)}m`);
  ok(fw.independentTournaments === 6, 'counts independent tournaments', `${fw.independentTournaments}`);
}

// ── 5. Hazard inference on synthetic avoidance ──────────────────────────────
section('5. Hazard inference on synthetic avoidance patterns');
{
  // A bunker centered right of the fairway midpoint that every round avoids.
  const mid: LatLng = { lat: (TRUE_TEE.lat + TRUE_GREEN.lat) / 2, lng: (TRUE_TEE.lng + TRUE_GREEN.lng) / 2 };
  const HAZARD: LatLng = { lat: mid.lat, lng: mid.lng + 25 / M_PER_DEG_LNG }; // 25m right of center
  const inHazard = (p: LatLng) => haversineMeters(p, HAZARD) < 14;

  const rounds: RoundTrack[] = [];
  for (let t = 0; t < 12; t++) {
    for (let p = 0; p < 3; p++) {
      // Each round goes AROUND the hazard on one side or the other (realistic:
      // some players bail left, some go right/short), so traffic brackets the
      // hazard while its center stays empty.
      const side = rng() < 0.5 ? -1 : 1;
      const pts: LatLng[] = [];
      for (let s = 0; s <= 24; s++) {
        const f = s / 24;
        const on: LatLng = { lat: TRUE_TEE.lat + (TRUE_GREEN.lat - TRUE_TEE.lat) * f, lng: TRUE_TEE.lng + (TRUE_GREEN.lng - TRUE_TEE.lng) * f };
        let pt = jitter(on, 5);
        // near the hazard's along-track fraction, swing wide around it
        if (f > 0.38 && f < 0.62) pt = jitter({ lat: on.lat, lng: on.lng + (25 + side * 30) / M_PER_DEG_LNG }, 5);
        if (!inHazard(pt)) pts.push(pt); // players never end up inside the hazard
      }
      rounds.push({ roundId: `${t}-${p}`, tournamentId: `T${t}`, points: pts });
    }
  }
  const hazards = inferHazards(TRUE_TEE, TRUE_GREEN, rounds);
  ok(hazards.length >= 1, 'detects at least one hazard region', `${hazards.length} region(s)`);
  if (hazards.length) {
    const nearest = hazards.reduce((best, h) => (haversineMeters(h.center, HAZARD) < haversineMeters(best.center, HAZARD) ? h : best));
    const errM = haversineMeters(nearest.center, HAZARD);
    ok(errM < 25, 'detected hazard sits near the true bunker', `${errM.toFixed(1)}m, conf ${nearest.confidence}`);
    ok(nearest.confidence >= VERIFIED_THRESHOLD, 'high confidence after 12 tournaments avoiding it', `${nearest.confidence}`);
  }

  // Negative control: no hazard, uniform coverage → few/no false positives.
  const clean: RoundTrack[] = [];
  for (let t = 0; t < 12; t++) {
    for (let p = 0; p < 3; p++) {
      const pts: LatLng[] = [];
      for (let s = 0; s <= 24; s++) {
        const f = s / 24;
        const on: LatLng = { lat: TRUE_TEE.lat + (TRUE_GREEN.lat - TRUE_TEE.lat) * f, lng: TRUE_TEE.lng + (TRUE_GREEN.lng - TRUE_TEE.lng) * f };
        pts.push(jitter(on, 18)); // wide, even spread, no avoidance
      }
      clean.push({ roundId: `c${t}-${p}`, tournamentId: `T${t}`, points: pts });
    }
  }
  const falsePos = inferHazards(TRUE_TEE, TRUE_GREEN, clean);
  ok(falsePos.length === 0, 'no false-positive hazards on evenly-covered fairway', `${falsePos.length} region(s)`);
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
