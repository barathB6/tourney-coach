// Day 22 — TV board data E2E. Seeds a live tournament with teams, players,
// scores (with recent birdies so trend is exercised), a committed sponsor with
// a logo, a paid registration (real "raised"), and contest holes; then asserts
// the /board endpoint returns all of it correctly. Prints the /tv URL for a
// screenshot. Contest holes need migration 029 (skipped gracefully if absent).
//   npx tsx scripts/e2e-day22-board.ts run    (keeps data, prints TV URL)
//   npx tsx scripts/e2e-day22-board.ts purge
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';

const COURSE = 'ZZZ D22 TEST COURSE — SAFE TO DELETE';
const T_NAME = 'ZZZ D22 TEST — St. Andrews Charity Scramble — SAFE TO DELETE';
// A tiny neutral logo (data URI) — the TV whites it out, so shape is all that matters.
const LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="6" fill="#333"/><text x="60" y="26" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">ACME</text></svg>');

let failures = 0;
const ok = (c: boolean, m: string, d = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${d ? ` — ${d}` : ''}`); if (!c) failures++; };

async function run() {
  console.log(`Day 22 board E2E against ${BASE}\n`);
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const organizerId = anyT?.organizer_id;
  const { data: course } = await db.from('courses').insert({ name: COURSE, city: 'Testville', state: 'CA', total_holes: 18, organizer_id: organizerId, profile_status: 'draft' }).select('id').single();
  if (!course) return finish();
  const pars = [4, 3, 5, 4, 4, 3, 4, 5, 4];
  for (let h = 1; h <= 9; h++) await db.from('course_holes').insert({ course_id: course.id, hole_number: h, par: pars[h - 1] });
  // LIVE tournament (board is draft-gated).
  const { data: t } = await db.from('tournaments').insert({ organizer_id: organizerId, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: course.id, format: 'scramble', max_score_rule: 'none', status: 'live' }).select('id').single();
  if (!t) return finish();

  const TEAMS = [
    { name: 'Northshore Toyota Eagles', players: ['Reed', 'Petrelli', 'Cho', 'Hinckley'], deltas: [-1, -1, -1, 0, -1, 0, -1, -1, -1], paid: 60000 },
    { name: 'Lambert & Co. Birdies', players: ['Lambert', 'Faro', 'Bell', 'Knight'], deltas: [-1, 0, -1, -1, 0, 0, -1, -1, 0], paid: 60000 },
    { name: "St. Michael's Dads", players: ['Curry', 'Ashford', 'Boudreaux', 'Hano'], deltas: [0, -1, -1, 0, -1, 0, 0, -1, 0], paid: 0 },
    { name: 'Riverbend Realty Putters', players: ['Petrelli', 'Carter', 'Lemoine', 'Falgout'], deltas: [-1, 0, 0, 0, -1, 0, -1, 0, 0], paid: 60000 },
    { name: 'Mandeville Mortgage', players: ['Adams', 'Bourg', 'Zito', 'Decuir'], deltas: [0, 0, 1, 0, -1, 0, 0, 0, 0], paid: 0 },
  ];
  const now = Date.now();
  for (const team of TEAMS) {
    const { data: reg } = await db.from('registrations').insert({
      tournament_id: t.id, registration_type: 'foursome', team_name: team.name, contact_name: team.players[0],
      contact_email: 'd22@tourneycoach.com', total_amount_cents: team.paid || 60000, payment_status: team.paid ? 'paid' : 'pending',
      foursome_number: TEAMS.indexOf(team) + 1, players: team.players.map((n) => ({ name: n, email: '' })),
    }).select('id').single();
    if (!reg) continue;
    // Score all 9 holes; submission times ascending so "recent" = holes 7-9.
    for (let h = 1; h <= 9; h++) {
      await db.from('score_submissions').insert({
        registration_id: reg.id, tournament_id: t.id, course_id: course.id, device_id: null,
        hole_number: h, strokes: pars[h - 1] + team.deltas[h - 1], green_labeled_points: 0,
        submitted_at: new Date(now - (9 - h) * 60000).toISOString(),
      });
    }
  }
  // Committed sponsor with a logo + a contest hole.
  await db.from('sponsors').insert({ tournament_id: t.id, company: 'ACME Corp', logo_url: LOGO, amount_cents: 250000, status: 'paid' });
  const { error: contestErr } = await db.from('contest_holes').insert({ tournament_id: t.id, hole_number: 6, contest_type: 'hole_in_one', prize: 'A new car' });
  const contestsAvailable = !contestErr;

  // ── Assert the board endpoint ──────────────────────────────────────────────
  const res = await fetch(`${BASE}/api/tournament/${t.id}/board`, { cache: 'no-store' } as RequestInit);
  const b = await res.json();
  ok(res.status === 200, 'board endpoint returns 200');
  ok(Array.isArray(b.standings) && b.standings.length === 5, 'all 5 teams present', `${b.standings?.length}`);
  const leader = b.standings[0];
  ok(leader.teamName === 'Northshore Toyota Eagles' && leader.toPar === -7, 'leader is the Eagles at -7', `${leader.teamName} ${leader.toPar}`);
  ok(Array.isArray(leader.players) && leader.players.length === 4, 'team player names included', leader.players?.join(','));
  ok(leader.trend && leader.trend.direction === 'up', 'leader trend is up (recent birdies)', JSON.stringify(leader.trend));
  ok(Array.isArray(b.sponsors) && b.sponsors.length === 1 && b.sponsors[0].company === 'ACME Corp', 'committed sponsor with logo surfaced');
  // Raised: 3 paid regs × $600 + sponsor $2500 = $1800 + $2500 = $4300 = 430000c
  ok(b.raisedCents === 430000, 'raised total is REAL money (paid regs + paid sponsor)', `$${(b.raisedCents / 100).toFixed(0)}`);
  if (contestsAvailable) ok(Array.isArray(b.contests) && b.contests.length === 1 && b.contests[0].holeNumber === 6, 'contest hole surfaced');
  else console.log('  ~ contest holes skipped — migration 029 not applied yet');

  console.log(`\n  TV board:     ${BASE}/tv/${t.id}`);
  console.log(`  Player board: ${BASE}/leaderboard/${t.id}`);
  finish();
}

async function purge() {
  console.log('Purging ZZZ D22 TEST entities…');
  const { data: ts } = await db.from('tournaments').select('id, name').eq('name', T_NAME);
  for (const t of ts ?? []) {
    for (const table of ['score_submissions', 'sponsors', 'contest_holes', 'gps_tracks']) {
      const { error } = await db.from(table).delete().eq('tournament_id', t.id);
      if (error && !/does not exist|schema cache/.test(error.message)) console.log(`  !! ${table}: ${error.message}`);
    }
    const { error } = await db.from('tournaments').delete().eq('id', t.id);
    console.log(error ? `  !! ${error.message}` : `  deleted tournament`);
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE);
  for (const c of cs ?? []) await db.from('courses').delete().eq('id', c.id);
  const { data: left } = await db.from('tournaments').select('id').eq('name', T_NAME);
  console.log(`Remaining: ${left?.length ?? 0}`);
  if ((left?.length ?? 0) > 0) process.exit(1);
}

function finish() { console.log(`\n${failures === 0 ? '✅ D22 BOARD CHECKS PASSED' : `❌ ${failures} FAILED`}`); process.exit(failures === 0 ? 0 : 1); }
const mode = process.argv[2];
if (mode === 'run') run(); else if (mode === 'purge') purge(); else { console.log('usage: run|purge'); process.exit(1); }
