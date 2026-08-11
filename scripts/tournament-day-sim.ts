// DAY 35 — a full tournament day, driven end to end against production.
//
// This is a DRESS REHEARSAL, and it says so plainly: a script cannot summon
// real golfers, so the GPS tracks and TourneyCircle opt-ins it produces are
// simulated, not human. What it DOES prove is that the whole tournament-day
// pipeline — the one a real event runs through — works under realistic
// conditions against the live platform: a field registers and pays, consents to
// GPS, tees off on a shotgun, posts position pings and scores hole by hole, opts
// into TourneyCircle at the end of the round, the kitchen fires on pace, and the
// tournament closes. Every ingestion call is the REAL production endpoint a
// player's phone hits, so a green run means those pipelines are wired and
// standing up to a day's worth of traffic.
//
// It runs on a THROWAWAY tournament so the beta's own roster stays clean, and
// tears everything down at the end.
//
//   E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/tournament-day-sim.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { fireTrigger } from '../lib/dayof/triggers';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const TAG = 'ZZZ BETA-DAY';
const DOM = `${RUN}.betaday.example.invalid`;

// A realistic small beta: 6 foursomes (24 players) around Beau Chene, Mandeville.
const FOURSOMES = 6;
const HOLES = 18;
const COURSE = { lat: 30.35825, lng: -90.06563 }; // Beau Chene centroid

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const api = async (path: string, body: unknown) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, ms: Date.now() - t0, ok: r.ok };
  } catch { return { status: 0, ms: Date.now() - t0, ok: false }; }
};
// A point a few metres off the course centroid — a plausible on-course ping.
const jitter = (i: number) => ({ lat: COURSE.lat + (Math.sin(i) * 0.002), lng: COURSE.lng + (Math.cos(i) * 0.002) });

async function main() {
  console.log(`Base: ${BASE}  —  ${FOURSOMES} foursomes × ${HOLES} holes\n`);
  const metrics = { registrations: 0, paid: 0, devices: 0, trackBatches: 0, gpsPoints: 0, teeMarks: 0, scores: 0, optIns: 0, apiCalls: 0, apiErrors: 0, boardMs: [] as number[] };

  // ── Setup: a throwaway published tournament on a real-coord course ────────
  const { data: owner } = await db.auth.admin.createUser({ email: `zzz-betaday-${RUN}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true });
  const ownerId = owner!.user!.id;
  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE ${RUN}`, city: 'Mandeville', state: 'LA', zip: '70471',
    total_holes: 18, par_total: 72, latitude: COURSE.lat, longitude: COURSE.lng,
  }).select('id').single();
  const courseId = course!.id as string;
  // A par-72 hole layout so scores have pars to compare against.
  await db.from('course_holes').insert(Array.from({ length: 18 }, (_, i) => ({
    course_id: courseId, hole_number: i + 1, par: [4, 4, 3, 5, 4, 4, 3, 5, 4][i % 9], handicap: i + 1,
  })));
  const eventDate = new Date().toISOString().slice(0, 10); // today — it's tournament day
  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} ${RUN}`, organizer_id: ownerId, event_date: eventDate, shotgun_time: '8:00 AM',
    format: 'scramble', max_players: FOURSOMES * 4, entry_fee_cents: 12500, status: 'live',
    slug: `zzz-betaday-${RUN}`, course_id: courseId,
  }).select('id').single();
  const tid = t!.id as string;

  const cleanup = async () => {
    // Devices belong to registrations, not the tournament — clear them (and the
    // consent/track rows that cascade off them) before the registrations go.
    const { data: runRegs } = await db.from('registrations').select('id').eq('tournament_id', tid);
    const rIds = (runRegs ?? []).map((r) => r.id);
    if (rIds.length) {
      const { data: devs } = await db.from('gps_devices').select('id').in('registration_id', rIds);
      for (const d of devs ?? []) {
        await db.from('gps_consent_events').delete().eq('device_id', d.id).then(() => {}, () => {});
        await db.from('gps_tracks').delete().eq('device_id', d.id).then(() => {}, () => {});
      }
      if (devs?.length) await db.from('gps_devices').delete().in('id', devs.map((d) => d.id));
    }
    for (const tbl of ['gps_tracks', 'score_submissions',
      'tourneycircle_sends', 'tournament_events', 'communication_log', 'registrations']) {
      await db.from(tbl).delete().eq('tournament_id', tid).then(() => {}, () => {});
    }
    // Members/declines are keyed by player_profile_id — clean by our run's emails.
    const { data: profs } = await db.from('player_profiles').select('id').ilike('email', `%${DOM}`);
    for (const p of profs ?? []) {
      await db.from('tourneycircle_members').delete().eq('player_profile_id', p.id).then(() => {}, () => {});
      await db.from('tourneycircle_declines').delete().eq('player_profile_id', p.id).then(() => {}, () => {});
    }
    await db.from('gps_tracks').delete().eq('course_id', courseId).then(() => {}, () => {});
    await db.from('course_holes').delete().eq('course_id', courseId);
    await db.from('tournaments').delete().eq('id', tid);
    await db.from('courses').delete().eq('id', courseId);
    await db.auth.admin.deleteUser(ownerId);
  };

  try {
    // ── 1. The field registers and pays ──────────────────────────────────────
    console.log('1. Registration & check-in');
    const regs: { id: string; captain: string }[] = [];
    for (let f = 0; f < FOURSOMES; f++) {
      const captain = `${TAG} Captain ${f}`;
      const r = await fetch(`${BASE}/api/registrations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournament_id: tid, registration_type: 'foursome', contact_name: captain, contact_email: `cap${f}-${RUN}@${DOM}`, players: Array.from({ length: 4 }, (_, i) => ({ name: `${TAG} P${f}-${i}` })) }),
      });
      metrics.apiCalls++; if (!r.ok) metrics.apiErrors++;
      const d = await r.json().catch(() => ({}));
      const id = d.registration?.id ?? d.id;
      if (id) { regs.push({ id, captain }); }
    }
    // Mark them paid (Adyen sandbox charges aren't scriptable; the platform's
    // manual-paid path is the honest stand-in for "money collected").
    await db.from('registrations').update({ payment_status: 'paid' }).eq('tournament_id', tid);
    metrics.registrations = regs.length; metrics.paid = regs.length;
    ok(regs.length === FOURSOMES, `${FOURSOMES} foursomes registered & paid`, `${regs.length}`);

    // Check them all in.
    for (const r of regs) await db.from('registrations').update({ checked_in_at: new Date().toISOString() }).eq('id', r.id);

    // ── 2. Shotgun start ─────────────────────────────────────────────────────
    console.log('\n2. Shotgun start');
    const shotgun = await fireTrigger(db, tid, 'shotgun_started');
    ok(shotgun.ok, 'shotgun trigger fired');

    // ── 3. The round — GPS + scores, hole by hole, all foursomes at once ─────
    console.log('\n3. The live round — consent, GPS tracks, tee marks, scores');
    // Each foursome consents one device, then plays 18 holes.
    const play = async (r: { id: string; captain: string }, fIdx: number) => {
      const deviceToken = `dev-${RUN}-${fIdx}-${Math.random().toString(36).slice(2)}`;
      const consent = await api('/api/gps/consent', { registrationId: r.id, deviceToken, playerName: r.captain });
      metrics.apiCalls++; if (!consent.ok) { metrics.apiErrors++; return; }
      metrics.devices++;
      for (let h = 1; h <= HOLES; h++) {
        const p = jitter(fIdx * 100 + h);
        // Tee mark
        const tee = await api('/api/gps/mark-tee', { deviceToken, holeNumber: h, lat: p.lat, lng: p.lng });
        metrics.apiCalls++; if (tee.ok) metrics.teeMarks++; else metrics.apiErrors++;
        // A batch of position pings across the hole
        const points = Array.from({ length: 4 }, (_, k) => ({ lat: p.lat + k * 0.0003, lng: p.lng + k * 0.0003, accuracy: 5, recordedAt: new Date(Date.now() - (4 - k) * 30000).toISOString() }));
        const track = await api('/api/gps/track', { deviceToken, tournamentId: tid, courseId, holeNumber: h, points });
        metrics.apiCalls++; if (track.ok) { metrics.trackBatches++; metrics.gpsPoints += points.length; } else metrics.apiErrors++;
        // Score for the hole
        const par = [4, 4, 3, 5, 4, 4, 3, 5, 4][(h - 1) % 9];
        const strokes = par + (h % 3 === 0 ? 1 : 0);
        const score = await api('/api/gps/score', { deviceToken, holeNumber: h, strokes, currentLat: p.lat, currentLng: p.lng, currentAccuracy: 5, enteredAt: new Date().toISOString() });
        metrics.apiCalls++; if (score.ok) metrics.scores++; else metrics.apiErrors++;
      }
      // ── 4. TourneyCircle opt-in at the end of the round ───────────────────
      const home = { lat: COURSE.lat + 0.05 + fIdx * 0.01, lng: COURSE.lng + 0.05 };
      const opt = await api('/api/circle/opt-in', { registrationId: r.id, radiusMiles: 25, homeLat: home.lat, homeLng: home.lng, causes: ['youth sports'] });
      metrics.apiCalls++; if (opt.ok) metrics.optIns++; else metrics.apiErrors++;
    };
    await Promise.all(regs.map((r, i) => play(r, i)));
    ok(metrics.scores >= FOURSOMES * HOLES * 0.9, 'scores posted for the field', `${metrics.scores}/${FOURSOMES * HOLES}`);
    ok(metrics.gpsPoints > 0, 'GPS position data collected', `${metrics.gpsPoints} points, ${metrics.teeMarks} tee marks`);
    ok(metrics.optIns > 0, 'TourneyCircle opt-ins captured', `${metrics.optIns} players`);

    // ── 5. Live board holds up mid-round ─────────────────────────────────────
    console.log('\n4. Live board under a scoring field');
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/tournament/${tid}/board`);
      await r.text();
      metrics.boardMs.push(Date.now() - t0);
    }
    const bmax = Math.max(...metrics.boardMs);
    ok(bmax < 3000, 'board serves within 3s while scores are live', `max ${bmax}ms over 10 reads`);

    // ── 6. Kitchen fires, tournament completes ───────────────────────────────
    console.log('\n5. Kitchen + close-out');
    const kitchen = await fireTrigger(db, tid, 'kitchen_fired');
    ok(kitchen.ok, 'kitchen trigger fired');
    const complete = await fireTrigger(db, tid, 'tournament_complete');
    ok(complete.ok, 'tournament completed');

    // ── 7. What was actually collected (the patent-relevant network) ─────────
    console.log('\n6. What the day produced (verified in the database)');
    // gps_devices is keyed by registration_id (a device belongs to a foursome),
    // not tournament_id — count via this run's registrations.
    const regIds = regs.map((r) => r.id);
    const [{ count: tracks }, { count: devices }, { count: scores }, { count: members }] = await Promise.all([
      db.from('gps_tracks').select('id', { count: 'exact', head: true }).eq('course_id', courseId),
      db.from('gps_devices').select('id', { count: 'exact', head: true }).in('registration_id', regIds),
      db.from('score_submissions').select('id', { count: 'exact', head: true }).eq('tournament_id', tid),
      db.from('tourneycircle_members').select('id', { count: 'exact', head: true }).ilike('email', `%${DOM}`),
    ]);
    ok((tracks ?? 0) > 0, 'GPS tracks persisted to the course network (patent-priority data path)', `${tracks} rows`);
    ok((devices ?? 0) === FOURSOMES, 'a consented device per foursome', `${devices}`);
    ok((members ?? 0) > 0, 'TourneyCircle members persisted (opt-in data path)', `${members}`);

    console.log('\n─── METRICS ───');
    console.log(`  registrations paid:  ${metrics.paid}`);
    console.log(`  consented devices:   ${devices}`);
    console.log(`  GPS track rows:      ${tracks}  (${metrics.gpsPoints} points sent, ${metrics.teeMarks} tee marks)`);
    console.log(`  scores in DB:        ${scores}`);
    console.log(`  TourneyCircle opt-ins: ${members}`);
    console.log(`  API calls:           ${metrics.apiCalls}  (${metrics.apiErrors} errors, ${(100 * (1 - metrics.apiErrors / Math.max(1, metrics.apiCalls))).toFixed(1)}% success)`);
    console.log(`  board latency:       max ${Math.max(...metrics.boardMs)}ms, median ${[...metrics.boardMs].sort((a, b) => a - b)[5]}ms`);
    ok(metrics.apiErrors === 0, 'ZERO API errors across the whole day', `${metrics.apiCalls} calls`);
  } finally {
    await cleanup();
    console.log('\n  (dress-rehearsal tournament removed)');
  }

  console.log(failures === 0
    ? '\n✅ TOURNAMENT DAY — the full pipeline runs a tournament end to end'
    : `\n❌ TOURNAMENT DAY — ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
