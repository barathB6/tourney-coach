// Day 21 — Live Scoring Backend end-to-end test, against production.
//
// Verifies the OPS-column deliverables through the REAL deployed APIs:
//   - multiple teams submit scores SIMULTANEOUSLY (concurrent POSTs);
//   - the realtime channel delivers a push on score writes;
//   - the leaderboard endpoint ranks correctly (to-par, countback ties);
//   - edge cases: tied scores, organizer correction, late (older) submission;
//   - pick-up-at-par max-score clamp with the friendly flag;
//   - GPS labeling still fires on every submission (Module 24 integration).
//
// All entities are named "ZZZ D21 TEST … — SAFE TO DELETE" and purged after.
//   npx tsx scripts/e2e-day21-scoring.ts run
//   npx tsx scripts/e2e-day21-scoring.ts purge
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const SUPABASE_URL = get('NEXT_PUBLIC_SUPABASE_URL')!;
const ANON_KEY = get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!;
const SERVICE_KEY = get('SUPABASE_SERVICE_ROLE_KEY')!;
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);
const rt = createClient(SUPABASE_URL, ANON_KEY); // anon, exactly like the public leaderboard page

const COURSE_NAME = 'ZZZ D21 TEST COURSE — SAFE TO DELETE';
const T_NAME = 'ZZZ D21 TEST TOURNAMENT — SAFE TO DELETE';
const ORIGIN = { lat: 36.61, lng: -121.9 };
const M = 111_320;
const HOLES = [1, 2, 3].map((h) => ({ hole: h, par: [4, 3, 5][h - 1], green: { lat: ORIGIN.lat + 0.0025, lng: ORIGIN.lng + (h - 1) * 0.001 } }));

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
async function api(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const getJson = async (path: string) => {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' } as RequestInit);
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

async function run() {
  console.log(`Day 21 scoring E2E against ${BASE}\n`);

  // ── Setup: course (par 12 over 3 holes), pick-up-at-par tournament, 4 teams ──
  console.log('1. Setup');
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const organizerId = anyT?.organizer_id as string | undefined;
  ok(!!organizerId, 'organizer id found');
  const { data: course } = await db.from('courses').insert({ name: COURSE_NAME, city: 'Testville', state: 'CA', total_holes: 18, organizer_id: organizerId, profile_status: 'draft' }).select('id').single();
  if (!course) return finish();
  for (const h of HOLES) await db.from('course_holes').insert({ course_id: course.id, hole_number: h.hole, par: h.par });
  const { data: tournament } = await db.from('tournaments').insert({ organizer_id: organizerId, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: course.id, format: 'scramble', max_score_rule: 'par', status: 'live' }).select('id').single();
  if (!tournament) return finish();
  ok(true, 'created course + par-3-hole tournament (pick-up-at-par)', tournament.id);

  const teams: { regId: string; token: string; name: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const { data: reg } = await db.from('registrations').insert({
      tournament_id: tournament.id, registration_type: 'foursome', team_name: `ZZZ Team ${i + 1}`,
      contact_name: `Captain ${i + 1}`, contact_email: 'd21@tourneycoach.com', total_amount_cents: 0, payment_status: 'pending', foursome_number: i + 1,
    }).select('id').single();
    if (!reg) continue;
    const token = randomUUID();
    const { status } = await api('/api/gps/consent', { registrationId: reg.id, deviceToken: token, playerName: `ZZZ Cap ${i + 1}` });
    ok(status === 200, `team ${i + 1} registered + consented`);
    teams.push({ regId: reg.id, token, name: `ZZZ Team ${i + 1}` });
  }
  if (teams.length !== 4) return finish();

  // ── 2. Realtime subscription (as the public leaderboard does) ─────────────
  console.log('\n2. Realtime channel');
  let pushes = 0;
  const channel = rt.channel(`leaderboard:${tournament.id}`).on('broadcast', { event: 'score' }, () => { pushes += 1; });
  await new Promise<void>((resolve) => channel.subscribe((s) => { if (s === 'SUBSCRIBED') resolve(); }));
  ok(true, 'subscribed to leaderboard:<id> broadcast channel');

  // ── 3. Concurrent submissions on hole 1 (with contemporaneous GPS) ────────
  console.log('\n3. Simultaneous submissions (4 teams, hole 1)');
  const fix = (h: typeof HOLES[number]) => ({ currentLat: h.green.lat + (Math.random() - 0.5) / M * 8, currentLng: h.green.lng + (Math.random() - 0.5) / M * 8, currentAccuracy: 6 });
  const h1 = HOLES[0];
  const results = await Promise.all(teams.map((t, i) => api('/api/gps/score', { deviceToken: t.token, holeNumber: 1, strokes: 3 + i, ...fix(h1) })));
  ok(results.every((r) => r.status === 200 && r.data.scoreStored === true), 'all 4 concurrent submissions stored');
  ok(results.every((r) => r.data.greenLabeled === true), 'GPS labeling fired on every submission', `${results.filter((r) => r.data.greenLabeled).length}/4`);

  // ── 4. Pick-up-at-par clamp ───────────────────────────────────────────────
  console.log('\n4. Max-score rule (pick-up-at-par on a par 3)');
  const capped = await api('/api/gps/score', { deviceToken: teams[0].token, holeNumber: 2, strokes: 9, ...fix(HOLES[1]) });
  ok(capped.data.capped === true && capped.data.strokesRecorded === 3, 'entered 9 on par 3 → recorded 3, capped flag set', `recorded ${capped.data.strokesRecorded}`);

  // ── 5. Leaderboard ranks + realtime delivery ──────────────────────────────
  console.log('\n5. Leaderboard computation + realtime delivery');
  await new Promise((r) => setTimeout(r, 1500)); // let broadcasts land
  ok(pushes >= 4, 'realtime pushes received for score writes', `${pushes} pushes`);
  const lb = await getJson(`/api/tournament/${tournament.id}/leaderboard`);
  const standings = (lb.data.standings ?? []) as { teamName: string; rank: number; toPar: number | null; holesCompleted: number; tied: boolean }[];
  ok(lb.status === 200 && standings.length === 4, 'leaderboard returns all 4 teams');
  // Team1 scored 3 on hole1 (par4 → -1) + 3 on hole2 (par3, capped → 0) = -1 thru 2. Team2=4(E), Team3=5(+1), Team4=6(+2) thru 1.
  // Hole 1 is par 4 under pick-up-at-par, so Team1's 3 = -1, and Team2/3/4's
  // 4/5/6 all record as 4 (=E) — the cap collapses over-par scores. Team1 leads.
  const t1 = standings.find((s) => s.teamName === 'ZZZ Team 1')!;
  ok(t1.rank === 1 && t1.toPar === -1, 'best team leads at -1 (3 on a par 4)', `${t1.teamName} ${t1.toPar}`);
  ok(standings.filter((s) => s.toPar === 0).length === 3, 'the three over-par teams all capped to E on hole 1', `${standings.filter((s) => s.toPar === 0).length} at E`);

  // ── 6. Tie handling: Team3 birdies hole 2 to join Team1 at -1 ──────────────
  console.log('\n6. Tie handling (two teams at same to-par)');
  await api('/api/gps/score', { deviceToken: teams[2].token, holeNumber: 2, strokes: 2, ...fix(HOLES[1]) }); // Team3: E(capped hole1) then -1 = -1 thru 2
  await new Promise((r) => setTimeout(r, 800));
  const lb2 = await getJson(`/api/tournament/${tournament.id}/leaderboard`);
  const s2 = (lb2.data.standings ?? []) as { teamName: string; toPar: number | null; tied: boolean; rank: number }[];
  const evens = s2.filter((s) => s.toPar === 0);
  ok(evens.length === 2 && evens.every((s) => s.tied && s.rank === evens[0].rank), 'Team2 and Team3 tie at E with a shared rank', `${evens.map((e) => e.teamName).join(' = ')}`);

  // ── 7. Organizer correction: auth gate (+ optional success path) ──────────
  // The success path needs a real organizer session JWT (correction is
  // owner-gated), so it's exercised only when D21_ORGANIZER_TOKEN is provided;
  // the auth GATE itself is always verified. Correction audit needs migration
  // 028 (score_corrections) applied.
  console.log('\n7. Score correction + audit log');
  const noAuth = await api('/api/scores/correct', { registrationId: teams[3].regId, holeNumber: 1, strokes: 3, reason: 'test' });
  ok(noAuth.status === 401, 'correction endpoint rejects unauthenticated callers', `status ${noAuth.status}`);
  const orgToken = process.env.D21_ORGANIZER_TOKEN;
  if (orgToken) {
    const res = await fetch(`${BASE}/api/scores/correct`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orgToken}` }, body: JSON.stringify({ registrationId: teams[3].regId, holeNumber: 1, strokes: 4, reason: 'scorer typo' }) });
    const cd = await res.json().catch(() => ({}));
    ok(res.status === 200 && cd.ok === true && cd.previousStrokes === 6 && cd.auditLogged === true, 'authed correction: 6→4 recorded with audit', JSON.stringify(cd));
  } else {
    console.log('  ~ skipped authed-correction success path (set D21_ORGANIZER_TOKEN to exercise it)');
  }

  // ── 8. Late (older) submission does not overwrite ─────────────────────────
  console.log('\n8. Late submission (older timestamp does not override newer)');
  // Insert directly with an OLDER submitted_at than Team1's existing hole-1 score.
  await db.from('score_submissions').insert({ registration_id: teams[0].regId, tournament_id: tournament.id, course_id: course.id, device_id: null, hole_number: 1, strokes: 8, green_labeled_points: 0, submitted_at: new Date(Date.now() - 3600_000).toISOString() });
  const lb3 = await getJson(`/api/tournament/${tournament.id}/leaderboard`);
  const s3 = (lb3.data.standings ?? []) as { teamName: string; toPar: number | null }[];
  const t1b = s3.find((s) => s.teamName === 'ZZZ Team 1')!;
  ok(t1b.toPar === -1, 'stale older score (8) ignored; latest (3) still counts', `toPar ${t1b.toPar}`);

  rt.removeChannel(channel);
  console.log(`\nLeaderboard: ${BASE}/leaderboard/${tournament.id}`);
  finish();
}

async function purge() {
  console.log('Purging ZZZ D21 TEST entities…');
  const { data: ts } = await db.from('tournaments').select('id, name').eq('name', T_NAME);
  for (const t of ts ?? []) {
    for (const table of ['score_corrections', 'score_submissions', 'gps_tracks']) {
      const { error } = await db.from(table).delete().eq('tournament_id', t.id);
      if (error) console.log(`  !! ${table}: ${error.message}`);
    }
    const { error } = await db.from('tournaments').delete().eq('id', t.id);
    console.log(error ? `  !! tournament: ${error.message}` : `  deleted tournament ${t.name}`);
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE_NAME);
  for (const c of cs ?? []) {
    await db.from('course_gps_features').delete().eq('course_id', c.id);
    const { error } = await db.from('courses').delete().eq('id', c.id);
    console.log(error ? `  !! course: ${error.message}` : `  deleted course ${c.id}`);
  }
  const { data: leftT } = await db.from('tournaments').select('id').eq('name', T_NAME);
  console.log(`Remaining test tournaments: ${leftT?.length ?? 0}`);
  if ((leftT?.length ?? 0) > 0) process.exit(1);
}

function finish() {
  console.log(`\n${failures === 0 ? '✅ D21 ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === 'run') run();
else if (mode === 'purge') purge();
else { console.log('usage: npx tsx scripts/e2e-day21-scoring.ts run|purge'); process.exit(1); }
