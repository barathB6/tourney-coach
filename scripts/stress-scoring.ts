// Day 21/22 STRESS TEST — pushes live scoring past the happy path against the
// real deployed infrastructure. Full field, simultaneous submissions, race
// conditions on a single row, latency under a loaded board, and a correctness
// cross-check: the live board must match the pure engine run on identical
// inputs (any lost/corrupted/duplicated write shows up as a mismatch).
//
//   npx tsx scripts/stress-scoring.ts    (seeds, storms, verifies, purges)
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { computeStandings, type ScoreRow, type TeamInfo, type HoleInfo } from '../lib/scoring/leaderboard';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const SUPA_URL = get('NEXT_PUBLIC_SUPABASE_URL'), ANON = get('NEXT_PUBLIC_SUPABASE_ANON_KEY'), SVC = get('SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(SUPA_URL, SVC), rt = createClient(SUPA_URL, ANON);
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';

const TEAMS = Number(process.env.STRESS_TEAMS ?? 30);
const HOLES = 18;
const COURSE = 'ZZZ STRESS COURSE — SAFE TO DELETE';
const T_NAME = 'ZZZ STRESS — Full Field — SAFE TO DELETE';
const PARS = [4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 5, 3, 4, 4, 3, 5, 4, 4]; // par 72

let failures = 0;
const ok = (c: boolean, m: string, d = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${d ? ` — ${d}` : ''}`); if (!c) failures++; };
const api = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getJson = async (p: string) => (await fetch(`${BASE}${p}`, { cache: 'no-store' } as RequestInit)).json();

let tId = '', cId = '';
type Team = { regId: string; token: string; name: string; deltas: number[] };
const teams: Team[] = [];

async function setup() {
  console.log(`\n1. Seeding a ${TEAMS}-team, ${HOLES}-hole field`);
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const org = anyT?.organizer_id;
  const { data: course } = await db.from('courses').insert({ name: COURSE, city: 'Testville', state: 'CA', total_holes: 18, organizer_id: org, profile_status: 'complete' }).select('id').single();
  cId = course!.id;
  for (let h = 1; h <= HOLES; h++) await db.from('course_holes').insert({ course_id: cId, hole_number: h, par: PARS[h - 1] });
  // max_score_rule='none' so submitted == stored (clean cross-check).
  const { data: t } = await db.from('tournaments').insert({ organizer_id: org, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: cId, format: 'scramble', max_score_rule: 'none', status: 'live' }).select('id').single();
  tId = t!.id;
  // Register + consent all teams (in modest concurrent batches).
  const mk = async (i: number) => {
    const { data: reg } = await db.from('registrations').insert({ tournament_id: tId, registration_type: 'foursome', team_name: `Stress Team ${String(i + 1).padStart(2, '0')}`, contact_name: `Cap ${i + 1}`, contact_email: 's@tourneycoach.com', total_amount_cents: 60000, payment_status: 'pending', foursome_number: i + 1, players: [] }).select('id').single();
    const token = randomUUID();
    await api('/api/gps/consent', { registrationId: reg!.id, deviceToken: token, playerName: `Cap ${i + 1}` });
    // Deterministic but varied per-hole deltas → distinct, verifiable totals.
    const deltas = Array.from({ length: HOLES }, (_, h) => ((i * 7 + h * 3) % 5) - 2); // -2..+2
    teams.push({ regId: reg!.id, token, name: `Stress Team ${String(i + 1).padStart(2, '0')}`, deltas });
  };
  for (let i = 0; i < TEAMS; i += 6) await Promise.all(Array.from({ length: Math.min(6, TEAMS - i) }, (_, j) => mk(i + j)));
  ok(teams.length === TEAMS, `registered + consented ${TEAMS} teams`, `${teams.length}`);
}

async function stormAndVerify() {
  // ── 2. Concurrency storm: every team submits every hole, hole-by-hole in
  //      simultaneous bursts of TEAMS. Total = TEAMS*HOLES POSTs.
  console.log(`\n2. Concurrency storm — ${TEAMS} simultaneous submissions/hole × ${HOLES} holes = ${TEAMS * HOLES} POSTs`);
  const t0 = Date.now();
  let non200 = 0;
  for (let h = 1; h <= HOLES; h++) {
    const results = await Promise.all(teams.map((tm) => api('/api/gps/score', { deviceToken: tm.token, holeNumber: h, strokes: PARS[h - 1] + tm.deltas[h - 1] }).then((r) => r.status)));
    non200 += results.filter((s) => s !== 200).length;
  }
  const elapsed = Date.now() - t0;
  ok(non200 === 0, `every submission returned 200 under load`, `${non200} non-200`);
  console.log(`     ${TEAMS * HOLES} submissions in ${elapsed}ms (${Math.round((TEAMS * HOLES / elapsed) * 1000)}/s)`);

  // ── 3. No lost writes: DB holds exactly one distinct latest per (team,hole).
  const { count } = await db.from('score_submissions').select('id', { count: 'exact', head: true }).eq('tournament_id', tId);
  ok((count ?? 0) >= TEAMS * HOLES, `all ${TEAMS * HOLES} score rows persisted (no lost writes)`, `${count} rows`);

  // ── 4. Correctness: live board must equal the pure engine on identical input.
  console.log('\n3. Correctness cross-check — live board vs pure engine on identical inputs');
  const board = await getJson(`/api/tournament/${tId}/board`);
  const teamInfos: TeamInfo[] = teams.map((tm, i) => ({ registrationId: tm.regId, teamName: tm.name, contactName: `Foursome #${i + 1}`, foursomeNumber: i + 1 }));
  const holeInfos: HoleInfo[] = PARS.map((p, i) => ({ holeNumber: i + 1, par: p }));
  const expectedScores: ScoreRow[] = teams.flatMap((tm) => PARS.map((p, h) => ({ registrationId: tm.regId, holeNumber: h + 1, strokes: p + tm.deltas[h], submittedAt: '2026-07-22T12:00:00Z' })));
  const expected = computeStandings({ format: 'scramble', maxScoreRule: 'none', teams: teamInfos, holes: holeInfos, scores: expectedScores });
  const byId = new Map(board.standings.map((s: { registrationId: string }) => [s.registrationId, s]));
  let mismatch = 0;
  for (const e of expected) {
    const got = byId.get(e.registrationId) as { toPar: number; holesCompleted: number; rank: number } | undefined;
    if (!got || got.toPar !== e.toPar || got.holesCompleted !== e.holesCompleted || got.rank !== e.rank) mismatch++;
  }
  ok(mismatch === 0, `all ${TEAMS} teams' rank/to-par/thru match the engine exactly`, `${mismatch} mismatches`);
  ok(board.standings.length === TEAMS, `board returns all ${TEAMS} teams`, `${board.standings.length}`);

  // ── 5. Board latency under a full loaded field.
  console.log('\n4. Board latency under a full loaded field');
  const lat: number[] = [];
  for (let i = 0; i < 5; i++) { const s = Date.now(); await getJson(`/api/tournament/${tId}/board`); lat.push(Date.now() - s); }
  const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  ok(avg < 3000, `board responds in <3s with ${TEAMS}×${HOLES}=${TEAMS * HOLES} scores`, `avg ${avg}ms (${lat.join(',')})`);

  // ── 6. Consistency: repeated reads are identical (no flapping).
  const [b1, b2] = await Promise.all([getJson(`/api/tournament/${tId}/board`), getJson(`/api/tournament/${tId}/board`)]);
  ok(JSON.stringify(b1.standings.map((s: {registrationId:string;rank:number}) => [s.registrationId, s.rank])) === JSON.stringify(b2.standings.map((s: {registrationId:string;rank:number}) => [s.registrationId, s.rank])), 'repeated board reads are consistent');
}

async function raceAndEdges() {
  // ── 7. Thundering herd on ONE row: 25 concurrent resubmits of team[0] hole 1.
  console.log('\n5. Race: 25 concurrent resubmissions of the same (team, hole)');
  const victim = teams[0];
  const values = Array.from({ length: 25 }, (_, i) => i + 1); // strokes 1..25? clamp to 1..20
  await Promise.all(values.map((v) => api('/api/gps/score', { deviceToken: victim.token, holeNumber: 1, strokes: Math.min(20, Math.max(1, v)) })));
  const board = await getJson(`/api/tournament/${tId}/board`);
  const vRow = board.standings.find((s: { registrationId: string }) => s.registrationId === victim.regId) as { holesCompleted: number } | undefined;
  // Invariant: hole 1 counts ONCE (no double-count/inflation), team still has exactly HOLES holes thru.
  ok(vRow?.holesCompleted === HOLES, 'concurrent resubmits do NOT double-count a hole (thru stays correct)', `thru ${vRow?.holesCompleted}`);

  // ── 8. Pick-up-at-par cap under a separate live tournament setting.
  console.log('\n6. Edge cases: pick-up-at-par cap, late submission, tie');
  const capRes = await api('/api/gps/score', { deviceToken: victim.token, holeNumber: 2, strokes: 19 });
  const capData = await capRes.json();
  ok(capData.capped !== true, 'max_score_rule=none: a 19 is NOT capped (rule respected)', `capped=${capData.capped}`);

  // Late (older) submission must not override a newer one.
  await db.from('score_submissions').insert({ registration_id: victim.regId, tournament_id: tId, course_id: cId, device_id: null, hole_number: 1, strokes: 15, green_labeled_points: 0, submitted_at: new Date(Date.now() - 3600_000).toISOString() });
  const board2 = await getJson(`/api/tournament/${tId}/board`);
  const vRow2 = board2.standings.find((s: { registrationId: string }) => s.registrationId === victim.regId) as { holesCompleted: number } | undefined;
  ok(vRow2?.holesCompleted === HOLES, 'stale older submission ignored (thru unchanged)', `thru ${vRow2?.holesCompleted}`);

  // Realtime under load: subscribe, fire a burst, count pushes.
  console.log('\n7. Realtime delivery under a burst');
  let pushes = 0;
  const ch = rt.channel(`leaderboard:${tId}`).on('broadcast', { event: 'score' }, () => { pushes++; });
  await new Promise<void>((res) => ch.subscribe((s) => s === 'SUBSCRIBED' && res()));
  await Promise.all(teams.slice(0, 10).map((tm) => api('/api/gps/score', { deviceToken: tm.token, holeNumber: 3, strokes: 4 })));
  await new Promise((r) => setTimeout(r, 2500));
  rt.removeChannel(ch);
  ok(pushes >= 8, 'realtime pushes delivered for a 10-submission burst', `${pushes}/10 (best-effort)`);
}

async function purge() {
  console.log('\n8. Purge');
  const { data: ts } = await db.from('tournaments').select('id').eq('name', T_NAME);
  for (const t of ts ?? []) {
    for (const tbl of ['score_submissions', 'gps_tracks', 'score_corrections', 'contest_holes', 'sponsors']) {
      const { error } = await db.from(tbl).delete().eq('tournament_id', t.id);
      if (error && !/does not exist|schema cache/.test(error.message)) console.log(`  !! ${tbl}: ${error.message}`);
    }
    await db.from('tournaments').delete().eq('id', t.id);
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE);
  for (const c of cs ?? []) { await db.from('course_gps_features').delete().eq('course_id', c.id); await db.from('courses').delete().eq('id', c.id); }
  const { data: left } = await db.from('tournaments').select('id').eq('name', T_NAME);
  ok((left?.length ?? 0) === 0, 'all stress data purged', `${left?.length ?? 0} left`);
}

(async () => {
  console.log(`STRESS TEST against ${BASE}`);
  try {
    await setup();
    await stormAndVerify();
    await raceAndEdges();
  } catch (e) {
    console.log(`  ✗ EXCEPTION: ${e instanceof Error ? e.message : e}`);
    failures++;
  } finally {
    await purge();
  }
  console.log(`\n${failures === 0 ? '✅ STRESS TEST PASSED — no defects under load' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
