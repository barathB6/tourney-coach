// Live demo: ONE tournament, ONE first team of 4 phones plays 3 holes —
// exercises the whole day-of loop end to end and leaves it viewable:
//   consent → GPS collection (tee cluster + walk to green) → score submission
//   (labels the green — the patent mechanism) → cluster detection + aggregation
//   (writes the GPS hole map) → leaderboard + TV board + hole map all populated.
//
//   npx tsx scripts/demo-first-round.ts run     (seeds + runs pipeline, prints URLs, KEEPS data)
//   npx tsx scripts/demo-first-round.ts purge
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const SUPABASE_URL = get('NEXT_PUBLIC_SUPABASE_URL'), SERVICE_KEY = get('SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(SUPABASE_URL, SERVICE_KEY);
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';

const COURSE = 'ZZZ DEMO COURSE — SAFE TO DELETE';
const T_NAME = 'ZZZ DEMO — First Team Live Round — SAFE TO DELETE';

// 3-hole geometry (Monterey-ish); each hole runs south→north, tees offset east.
const ORIGIN = { lat: 36.5682, lng: -121.9497 };
const M_LAT = 111_320, M_LNG = M_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const HOLES = [1, 2, 3].map((h) => ({
  hole: h, par: [4, 3, 5][h - 1],
  tee: { lat: ORIGIN.lat, lng: ORIGIN.lng + ((h - 1) * 130) / M_LNG },
  green: { lat: ORIGIN.lat + 300 / M_LAT, lng: ORIGIN.lng + ((h - 1) * 130) / M_LNG },
}));
const jitter = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + ((Math.random() * 2 - 1) * m) / M_LAT, lng: p.lng + ((Math.random() * 2 - 1) * m) / M_LNG });

let failures = 0;
const ok = (c: boolean, m: string, d = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${d ? ` — ${d}` : ''}`); if (!c) failures++; };
async function api(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function run() {
  console.log(`First-team live round against ${BASE}\n`);
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const organizerId = anyT?.organizer_id;
  const { data: course } = await db.from('courses').insert({ name: COURSE, city: 'Pebble Beach', state: 'CA', total_holes: 18, organizer_id: organizerId, profile_status: 'complete' }).select('id').single();
  if (!course) return finish();
  for (const h of HOLES) await db.from('course_holes').insert({ course_id: course.id, hole_number: h.hole, par: h.par, tee_yardages: { white: 330 } });
  const { data: t } = await db.from('tournaments').insert({ organizer_id: organizerId, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: course.id, format: 'scramble', max_score_rule: 'par', status: 'live' }).select('id').single();
  if (!t) return finish();

  console.log('1. The first team registers + all 4 phones opt in');
  const { data: reg } = await db.from('registrations').insert({
    tournament_id: t.id, registration_type: 'foursome', team_name: 'The Founders Four',
    contact_name: 'Captain', contact_email: 'demo@tourneycoach.com', total_amount_cents: 60000, payment_status: 'paid',
    foursome_number: 1, players: ['Reed', 'Petrelli', 'Cho', 'Hinckley'].map((n) => ({ name: n, email: '' })),
  }).select('id').single();
  if (!reg) return finish();
  const devices = Array.from({ length: 4 }, () => randomUUID());
  for (const [i, token] of devices.entries()) {
    const { status } = await api('/api/gps/consent', { registrationId: reg.id, deviceToken: token, playerName: `Player ${i + 1}` });
    ok(status === 200, `phone ${i + 1} consented`);
  }

  console.log('\n2. They play each hole: phones collect GPS, captain submits the score');
  const scores = [4, 2, 5]; // birdie-ish round: -1, -1(par3 hole2→2), E
  for (const h of HOLES) {
    const scoreAt = Date.now();
    for (const token of devices) {
      // First ping = converged at the tee (→ tee cluster). Then walk to green.
      const pts = Array.from({ length: 16 }, (_, k) => {
        const f = k / 15;
        const on = { lat: h.tee.lat + (h.green.lat - h.tee.lat) * f, lng: h.tee.lng + (h.green.lng - h.tee.lng) * f };
        const p = jitter(on, f === 0 ? 4 : 6);
        return { ...p, accuracy: 6, recordedAt: new Date(scoreAt - (15 - k) * 15000).toISOString() };
      });
      await api('/api/gps/track', { deviceToken: token, tournamentId: t.id, courseId: course.id, holeNumber: h.hole, points: pts });
    }
    // Captain submits score with a contemporaneous fix at the green → labels the green.
    const g = jitter(h.green, 5);
    const res = await api('/api/gps/score', { deviceToken: devices[0], holeNumber: h.hole, strokes: scores[h.hole - 1], currentLat: g.lat, currentLng: g.lng, currentAccuracy: 6 });
    ok(res.data.scoreStored === true, `hole ${h.hole}: score ${scores[h.hole - 1]} stored`);
    ok(res.data.greenLabeled === true, `hole ${h.hole}: GREEN LABELED from the group's GPS (patent mechanism)`, `${res.data.labeledPoints} phones`);
  }

  console.log('\n3. Nightly pipeline: detect tee clusters + aggregate the course profile');
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  const { detectTeeClusters } = await import('../lib/gps/clustering');
  const { aggregateCourseProfiles } = await import('../lib/gps/aggregate');
  const clusters = await detectTeeClusters();
  const agg = await aggregateCourseProfiles();
  ok(clusters.length >= 3, 'tee boxes detected from the converging foursome', `${clusters.length} clusters`);
  console.log(`     aggregation: ${JSON.stringify(agg)}`);

  console.log('\n4. Everything is now live and viewable:');
  const lb = await (await fetch(`${BASE}/api/tournament/${t.id}/board`, { cache: 'no-store' } as RequestInit)).json();
  const team = lb.standings?.[0];
  ok(team?.teamName === 'The Founders Four', 'team is on the leaderboard', `${team?.teamName} ${team?.toPar} thru ${team?.holesCompleted}`);
  const prof = await (await fetch(`${BASE}/api/course/${course.id}/profile`)).json();
  const h1 = prof.holes?.find((x: { holeNumber: number }) => x.holeNumber === 1);
  ok(!!h1?.gpsDerived?.tee && !!h1?.gpsDerived?.green, 'hole map has GPS tee + green (from this round)', `tee conf ${h1?.gpsDerived?.tee?.confidence}, green conf ${h1?.gpsDerived?.green?.confidence}`);

  console.log(`\n  ► Player Live Round + hole map:  ${BASE}/live/${reg.id}`);
  console.log(`  ► Public leaderboard:            ${BASE}/leaderboard/${t.id}`);
  console.log(`  ► Clubhouse TV board:            ${BASE}/tv/${t.id}`);
  console.log(`  ► Team scorecard:                ${BASE}/scorecard/${reg.id}`);
  console.log(`\n  (data kept for viewing — run "purge" when done)`);
  finish();
}

async function purge() {
  console.log('Purging ZZZ DEMO entities…');
  const { data: ts } = await db.from('tournaments').select('id').eq('name', T_NAME);
  for (const t of ts ?? []) {
    for (const tbl of ['score_submissions', 'gps_tracks', 'contest_holes', 'sponsors']) {
      const { error } = await db.from(tbl).delete().eq('tournament_id', t.id);
      if (error && !/does not exist|schema cache/.test(error.message)) console.log(`  !! ${tbl}: ${error.message}`);
    }
    await db.from('tournaments').delete().eq('id', t.id);
    console.log('  deleted tournament + cascade');
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE);
  for (const c of cs ?? []) { await db.from('course_gps_features').delete().eq('course_id', c.id); await db.from('courses').delete().eq('id', c.id); }
  const { data: left } = await db.from('tournaments').select('id').eq('name', T_NAME);
  console.log(`Remaining: ${left?.length ?? 0}`);
}

function finish() { console.log(`\n${failures === 0 ? '✅ FIRST-TEAM ROUND: all steps verified' : `❌ ${failures} FAILED`}`); process.exit(failures === 0 ? 0 : 1); }
const mode = process.argv[2];
if (mode === 'run') run(); else if (mode === 'purge') purge(); else { console.log('usage: run|purge'); process.exit(1); }
