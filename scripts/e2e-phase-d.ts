// Day 20 — Phase D end-to-end integration test.
//
// Exercises the ENTIRE pipeline exactly as production runs it:
//   course (pro-entered) → tournament → registrations → consent API →
//   track-ingest API → score API (green labeling, the patent mechanism) →
//   cron aggregation (tee clusters + cross-tournament profile) →
//   hybrid profile endpoint.
//
// All test entities are named "ZZZ E2E TEST … — SAFE TO DELETE" and are
// removed by the purge phase. The sim covers TWO tournaments at the same
// course so cross-tournament accrual (tee per tournament, tournaments=2 in
// confidence) is verified live — the exact defect class the Day 19
// adversarial review caught.
//
//   npx tsx scripts/e2e-phase-d.ts run      # setup + simulate + aggregate + verify (keeps data, prints IDs)
//   npx tsx scripts/e2e-phase-d.ts purge    # remove all ZZZ E2E TEST entities
//   npx tsx scripts/e2e-phase-d.ts purge-demo  # remove the old St. Michael's demo GPS points (Day 18 leftovers)
//
// KNOWN BLAST RADIUS (accepted, reviewed):
// - The aggregation step (cron or direct-import fallback) is the same GLOBAL
//   pass production runs daily: it recomputes gps_status/hazards for every
//   course that has features, not just the test course. Idempotent on the
//   happy path; don't interrupt it mid-run, and don't use the direct-import
//   fallback with undeployed local lib/gps changes you don't trust.
// - Test entities are owned by an existing organizer account (there is no
//   dedicated test user), so the draft ZZZ tournaments are visible on that
//   organizer's dashboard until purge. Run purge promptly.
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const SUPABASE_URL = get('NEXT_PUBLIC_SUPABASE_URL')!;
const SERVICE_KEY = get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = process.env.CRON_SECRET ?? get('CRON_SECRET');
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const COURSE_NAME = 'ZZZ E2E TEST COURSE — SAFE TO DELETE';
const T_NAMES = ['ZZZ E2E TEST T1 — SAFE TO DELETE', 'ZZZ E2E TEST T2 — SAFE TO DELETE'];

// 3-hole test geometry (Monterey-ish). Hole h runs south→north, holes offset east.
const ORIGIN = { lat: 36.6002, lng: -121.8747 };
const M_LAT = 111_320;
const M_LNG = M_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const HOLES = [1, 2, 3].map((h) => ({
  hole: h,
  tee: { lat: ORIGIN.lat, lng: ORIGIN.lng + ((h - 1) * 120) / M_LNG },
  green: { lat: ORIGIN.lat + 300 / M_LAT, lng: ORIGIN.lng + ((h - 1) * 120) / M_LNG },
  par: [4, 3, 5][h - 1],
  hcp: [5, 15, 1][h - 1],
}));

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const jitter = (p: { lat: number; lng: number }, m: number) => ({
  lat: p.lat + ((Math.random() * 2 - 1) * m) / M_LAT,
  lng: p.lng + ((Math.random() * 2 - 1) * m) / M_LNG,
});

async function api(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, unknown> };
}

async function run() {
  console.log(`Phase D E2E against ${BASE}\n`);

  // ── 1. Pro-entered half: course + holes ───────────────────────────────────
  console.log('1. Course setup (pro-entered structured data)');
  // Some early seed tournaments have organizer_id null — need a real one.
  const { data: anyTournament } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  let organizerId = anyTournament?.organizer_id as string | undefined;
  if (!organizerId) {
    const { data: prof } = await db.from('profiles').select('id').limit(1).maybeSingle();
    organizerId = prof?.id;
  }
  ok(!!organizerId, 'found an organizer id to own test entities');

  const { data: course, error: courseErr } = await db
    .from('courses')
    .insert({ name: COURSE_NAME, city: 'Testville', state: 'CA', total_holes: 18, organizer_id: organizerId, profile_status: 'draft' })
    .select('id').single();
  ok(!courseErr && !!course, 'created test course', course?.id ?? courseErr?.message);
  if (!course) return finish();

  for (const h of HOLES) {
    const { error } = await db.from('course_holes').insert({
      course_id: course.id, hole_number: h.hole, par: h.par, handicap: h.hcp,
      tee_yardages: { white: Math.round(300 * 1.09361) },
    });
    ok(!error, `created hole ${h.hole} (par ${h.par}, hcp ${h.hcp})`, error?.message ?? '');
  }

  // ── 2. Tournaments + registrations (the foursome unit) ────────────────────
  console.log('\n2. Tournaments + registrations');
  const tournaments: { id: string; regId: string; devices: string[] }[] = [];
  for (const name of T_NAMES) {
    const { data: t, error: tErr } = await db
      .from('tournaments')
      .insert({ organizer_id: organizerId, name, event_date: new Date().toISOString().slice(0, 10), course_id: course.id, status: 'draft' })
      .select('id').single();
    ok(!tErr && !!t, `created ${name.slice(0, 15)}…`, tErr?.message ?? '');
    if (!t) continue;
    const { data: reg, error: rErr } = await db
      .from('registrations')
      .insert({
        tournament_id: t.id, registration_type: 'foursome', contact_name: 'ZZZ E2E Test Player',
        contact_email: 'e2e-test@tourneycoach.com', total_amount_cents: 0, payment_status: 'pending',
        foursome_number: 1, starting_hole: 1, players: [],
      })
      .select('id').single();
    ok(!rErr && !!reg, 'created foursome registration', rErr?.message ?? '');
    if (reg) tournaments.push({ id: t.id, regId: reg.id, devices: Array.from({ length: 4 }, () => randomUUID()) });
  }
  if (tournaments.length !== 2) return finish();

  // ── 3. Consent flow via the real API ──────────────────────────────────────
  console.log('\n3. Consent (real /api/gps/consent)');
  for (const t of tournaments) {
    for (const [i, token] of t.devices.entries()) {
      const { status, data } = await api('/api/gps/consent', { registrationId: t.regId, deviceToken: token, playerName: `ZZZ E2E P${i + 1}` });
      ok(status === 200 && !!data.deviceId, `device ${i + 1} consent recorded (${t.id === tournaments[0].id ? 'T1' : 'T2'})`);
    }
  }

  // ── 4. The mechanism: walk each hole, submit score, watch labeling fire ───
  console.log('\n4. Collection + score-submission green labeling (the inventive mechanism)');
  const PTS = 20;
  for (const [ti, t] of tournaments.entries()) {
    for (const h of HOLES) {
      const scoreAt = Date.now();
      for (const token of t.devices) {
        const points = Array.from({ length: PTS }, (_, i) => {
          const f = i / (PTS - 1);
          const on = { lat: h.tee.lat + (h.green.lat - h.tee.lat) * f, lng: h.tee.lng + (h.green.lng - h.tee.lng) * f };
          const p = jitter(on, f === 0 ? 5 : 6); // tight cluster on the tee
          return { ...p, accuracy: 8, recordedAt: new Date(scoreAt - (PTS - 1 - i) * 7500).toISOString() };
        });
        const { status, data } = await api('/api/gps/track', {
          deviceToken: token, tournamentId: t.id, courseId: course.id, holeNumber: h.hole, points,
        });
        if (status !== 200) ok(false, `track ingest T${ti + 1} hole ${h.hole}`, JSON.stringify(data));
      }
      const { status, data } = await api('/api/gps/score', { deviceToken: t.devices[0], holeNumber: h.hole, strokes: h.par });
      ok(status === 200 && data.scoreStored === true, `T${ti + 1} hole ${h.hole}: score stored`);
      ok(data.greenLabeled === true && Number(data.labeledPoints) >= 3, `T${ti + 1} hole ${h.hole}: green labeled from contemporaneous GPS`, `${data.labeledPoints} devices`);
    }
  }

  // ── 5. Aggregation: deployed cron, else same functions via direct import ──
  console.log('\n5. Cron aggregation');
  let aggregated = false;
  if (CRON_SECRET) {
    const res = await fetch(`${BASE}/api/cron/gps-clusters`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    if (res.status === 200) {
      const data = await res.json().catch(() => ({})) as { clustersDetected?: number };
      ok(Number(data.clustersDetected) >= HOLES.length * T_NAMES.length, 'deployed cron ran and detected the sim tee clusters', JSON.stringify(data));
      aggregated = true;
    } else {
      console.log(`  ! deployed cron returned ${res.status} — CRON_SECRET mismatch (flag for Vercel dashboard); falling back to direct import`);
    }
  }
  // 3 holes × 2 tournaments = 6 fresh tee clusters expected (global runs may
  // find more from real play; 6 is the lower bound this test just created).
  const EXPECTED_CLUSTERS = HOLES.length * T_NAMES.length;
  if (!aggregated) {
    // Same code the cron route calls, against the same production DB — only
    // the HTTP auth wrapper is skipped (Vercel's scheduled invocations
    // exercise that daily).
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    const { detectTeeClusters } = await import('../lib/gps/clustering');
    const { aggregateCourseProfiles, HAZARD_MIN_ROUNDS } = await import('../lib/gps/aggregate');
    // The negative-control hazard check below is only meaningful if the
    // inference gate actually opens for our 8 simulated rounds.
    ok(4 * T_NAMES.length >= HAZARD_MIN_ROUNDS, 'sim round count reaches the hazard-inference floor', `${4 * T_NAMES.length} rounds vs floor ${HAZARD_MIN_ROUNDS}`);
    const clusters = await detectTeeClusters();
    const agg = await aggregateCourseProfiles();
    ok(clusters.length >= EXPECTED_CLUSTERS, 'aggregation ran via direct import (cron-equivalent)', `clusters=${clusters.length} (expected ≥${EXPECTED_CLUSTERS}), ${JSON.stringify(agg)}`);
  }

  // ── 6. Verify the cross-tournament profile ─────────────────────────────────
  console.log('\n6. Verify aggregated hybrid profile');
  const { data: features } = await db
    .from('course_gps_features')
    .select('hole_number, feature_type, tournament_id')
    .eq('course_id', course.id);
  for (const h of HOLES) {
    const tees = (features ?? []).filter((f) => f.hole_number === h.hole && f.feature_type === 'tee_box');
    const greens = (features ?? []).filter((f) => f.hole_number === h.hole && f.feature_type === 'green');
    const teeTournaments = new Set(tees.map((f) => f.tournament_id));
    ok(tees.length === 2 && teeTournaments.size === 2, `hole ${h.hole}: one tee_box event PER TOURNAMENT (accrual fix live)`, `${tees.length} events, ${teeTournaments.size} tournaments`);
    ok(greens.length === 2, `hole ${h.hole}: green event per tournament's score`, `${greens.length}`);
  }

  const { data: holeRows } = await db
    .from('course_holes')
    .select('hole_number, gps_status')
    .eq('course_id', course.id)
    .order('hole_number');
  for (const row of holeRows ?? []) {
    const s = row.gps_status as Record<string, { confidence?: number; tournaments?: number } | { waypoints?: unknown[] } | null>;
    const tee = s.tee as { confidence?: number; tournaments?: number } | null;
    const green = s.green as { confidence?: number; tournaments?: number } | null;
    const fairway = s.fairway as { waypoints?: unknown[] } | null;
    ok(!!tee?.confidence && tee.tournaments === 2, `hole ${row.hole_number}: aggregated tee w/ confidence + tournaments=2`, `conf ${tee?.confidence}, T=${tee?.tournaments}`);
    ok(!!green?.confidence && green.tournaments === 2, `hole ${row.hole_number}: aggregated green w/ confidence + tournaments=2`, `conf ${green?.confidence}`);
    ok(Array.isArray(fairway?.waypoints) && fairway.waypoints.length >= 2, `hole ${row.hole_number}: fairway route`, `${fairway?.waypoints?.length ?? 0} waypoints`);
  }
  const hazardRows = (features ?? []).filter((f) => f.feature_type === 'hazard');
  const { data: hazardsQ } = await db.from('course_gps_features').select('id').eq('course_id', course.id).eq('feature_type', 'hazard');
  ok((hazardsQ ?? []).length === 0 && hazardRows.length === 0, 'no false-positive hazards on clean straight walks (live negative control)');

  const profRes = await fetch(`${BASE}/api/course/${course.id}/profile`);
  const prof = await profRes.json().catch(() => null);
  const h1 = prof?.holes?.find((x: { holeNumber: number }) => x.holeNumber === 1);
  ok(profRes.status === 200 && h1?.proEntered?.par === 4 && !!h1?.gpsDerived?.tee, 'hybrid profile endpoint fuses pro-entered + GPS-derived', `par=${h1?.proEntered?.par}, gps tee conf=${h1?.gpsDerived?.tee?.confidence}`);

  const { data: scores } = await db.from('score_submissions').select('id').in('tournament_id', tournaments.map((t) => t.id));
  ok((scores ?? []).length === 6, 'all 6 score submissions persisted', `${scores?.length}`);

  console.log(`\nLive Round URL for visual check: ${BASE}/live/${tournaments[0].regId}`);
  console.log(`Course id: ${course.id}`);
  finish();
}

async function purge() {
  console.log('Purging ZZZ E2E TEST entities…');
  // score_submissions/gps_tracks reference tournaments without ON DELETE
  // CASCADE, so dependents go first — and every delete error is surfaced,
  // never swallowed (the first version of this purge failed silently).
  const { data: ts } = await db.from('tournaments').select('id, name').in('name', T_NAMES);
  for (const t of ts ?? []) {
    for (const table of ['score_submissions', 'gps_tracks']) {
      const { error } = await db.from(table).delete().eq('tournament_id', t.id);
      if (error) console.log(`  !! ${table} for ${t.id}: ${error.message}`);
    }
    const { error } = await db.from('tournaments').delete().eq('id', t.id); // cascades regs → devices
    console.log(error ? `  !! tournament ${t.name}: ${error.message}` : `  deleted tournament ${t.name}`);
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE_NAME);
  for (const c of cs ?? []) {
    const { error: fErr } = await db.from('course_gps_features').delete().eq('course_id', c.id);
    const { error: cErr } = await db.from('courses').delete().eq('id', c.id); // cascades course_holes
    console.log(cErr || fErr ? `  !! course ${c.id}: ${(cErr ?? fErr)?.message}` : `  deleted course ${c.id} (+holes, +features)`);
  }
  // verify
  const { data: leftT } = await db.from('tournaments').select('id').in('name', T_NAMES);
  const { data: leftC } = await db.from('courses').select('id').eq('name', COURSE_NAME);
  console.log(`Remaining test tournaments: ${leftT?.length ?? 0}, courses: ${leftC?.length ?? 0}`);
  if ((leftT?.length ?? 0) + (leftC?.length ?? 0) > 0) process.exit(1);
}

// One-time cleanup of the Day 18 demo data. Already executed 2026-07-22;
// kept (hardened) in case demo data is ever recreated. Deletes are scoped to
// the ONE demo tournament — never the whole course's derived data, which may
// by then include real-tournament aggregates.
async function purgeDemo() {
  console.log('Purging Day 18 demo GPS points (St. Michael\'s Cup)…');
  const { data: matches, error: findErr } = await db.from('tournaments').select('id, name, course_id').ilike('name', '%st. michael%');
  if (findErr) { console.log(`  !! lookup failed: ${findErr.message}`); process.exit(1); }
  if (!matches?.length) { console.log('  tournament not found — nothing to do'); return; }
  if (matches.length > 1) {
    console.log('  !! multiple tournaments match — refusing to guess. Matches:');
    for (const m of matches) console.log(`     ${m.id}  ${m.name}`);
    process.exit(1);
  }
  const t = matches[0];
  console.log(`  target: ${t.name} (${t.id})`);
  const del = async (table: string, col: string, val: string) => {
    const { count, error: countErr } = await db.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
    if (countErr) { console.log(`  !! ${table} count failed: ${countErr.message}`); process.exit(1); }
    if (count) {
      const { error } = await db.from(table).delete().eq(col, val);
      if (error) { console.log(`  !! ${table} delete failed: ${error.message}`); process.exit(1); }
    }
    console.log(`  ${table}: removed ${count ?? 0}`);
  };
  await del('gps_tracks', 'tournament_id', t.id);
  await del('score_submissions', 'tournament_id', t.id);
  // Tournament-scoped ONLY: features from other (real) tournaments at the
  // same course must survive, and gps_status is left for the daily cron to
  // recompute from whatever features remain.
  await del('course_gps_features', 'tournament_id', t.id);
  console.log('  (gps_status left to the daily aggregation cron; consent audit log intentionally left intact)');
}

function finish() {
  console.log(`\n${failures === 0 ? '✅ E2E ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === 'run') run();
else if (mode === 'purge') purge();
else if (mode === 'purge-demo') purgeDemo();
else { console.log('usage: npx tsx scripts/e2e-phase-d.ts run|purge|purge-demo'); process.exit(1); }
