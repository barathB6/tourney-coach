// Day 25 — Phase E end-to-end integration test.
//
// Exercises the modules Phase E added, together, exactly as production runs
// them, and then attacks the result:
//   Module 12  Golf Pro Course Builder + delegated pro access (link + password)
//   Module 7   TourneyCircle opt-in / decline at round completion
//   Module 22  Aggregate counts dashboard (by radius, by cause)
//   Module 10  Notification engine (suppression, cadence, threshold floor)
//   Privacy    The Concept B firewall, re-attacked from an organizer's session
//
// The privacy phase is the point of this file. Phase E's deliverable is not
// "the dashboard renders" — it is "an organizer cannot reach an individual".
// So it signs in as a REAL organizer (a throwaway auth user), then tries the
// bypasses that a penetration pass actually found exploitable on this codebase,
// and fails the build if any of them come back.
//
//   npx tsx scripts/e2e-phase-e.ts run     # setup + exercise + attack + verify
//   npx tsx scripts/e2e-phase-e.ts purge   # remove every ZZZ E2E entity
//
// Requires migrations 036 + 037. Every entity created here is named
// "ZZZ E2E PHASE-E …" or uses an @example.invalid email, and purge removes
// them. Test players are deliberately registered to a SOURCE tournament and
// counted against a separate TARGET tournament, because a tournament's own
// registrants are (correctly) suppressed from its own reach.
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { MIN_DISCLOSABLE_COUNT, RADIUS_OPTIONS } from '../lib/tourneycircle';
import { issuedPassword } from '../lib/proAccess';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const SUPABASE_URL = get('NEXT_PUBLIC_SUPABASE_URL')!;
const SERVICE_KEY = get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!;
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const TAG = 'ZZZ E2E PHASE-E';
const COURSE_NAME = `${TAG} COURSE — SAFE TO DELETE`;
const T_SOURCE = `${TAG} SOURCE — SAFE TO DELETE`;
const T_TARGET = `${TAG} TARGET — SAFE TO DELETE`;
const EMAIL_DOMAIN = 'e2e-phase-e.example.invalid'; // never a real inbox

// Course sits in Mandeville, LA. 1 mile north ≈ 0.0145° latitude.
const COURSE_AT = { lat: 30.3600, lng: -90.0700 };
const atMiles = (mi: number) => ({ lat: COURSE_AT.lat + mi * 0.0145, lng: COURSE_AT.lng });

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

type Json = Record<string, unknown>;
async function call(path: string, init: RequestInit = {}): Promise<{ status: number; data: Json; raw: string }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const raw = await res.text();
  let data: Json = {};
  try { data = JSON.parse(raw) as Json; } catch { /* non-JSON body */ }
  return { status: res.status, data, raw };
}

// ── Setup helpers ───────────────────────────────────────────────────────────

async function makeOrganizer(label: string) {
  const email = `zzz-e2e-org-${label}-${Date.now()}@${EMAIL_DOMAIN}`;
  const password = `zzz-E2E-${randomUUID().slice(0, 12)}Aa1!`;
  const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !created?.user) throw new Error(`could not create test organizer: ${error?.message}`);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr || !sess.session) throw new Error(`could not sign in test organizer: ${sErr?.message}`);
  return { id: created.user.id, email, jwt: sess.session.access_token };
}
const bearer = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

async function run() {
  console.log(`Phase E integration test against ${BASE}`);
  console.log(`disclosure threshold = ${MIN_DISCLOSABLE_COUNT}\n`);

  // Migrations must be in place or the results would be meaningless.
  section('0. Preconditions');
  const { error: m36 } = await db.from('course_pro_access').select('id').limit(1);
  const { error: m37 } = await db.from('tourneycircle_sends').select('visit_token').limit(1);
  ok(!m36, 'migration 036 (course_pro_access) applied', m36?.message ?? '');
  ok(!m37, 'migration 037 (visit_token + column grants) applied', m37?.message ?? '');
  if (m36 || m37) { console.log('\nAborting — apply the migrations first.'); return finish(); }

  const organizer = await makeOrganizer('a');
  const outsider = await makeOrganizer('b'); // a DIFFERENT organizer, for cross-tenant checks
  ok(!!organizer.jwt && !!outsider.jwt, 'signed in two independent organizer sessions');

  // ── 1. Module 12 — course profile ─────────────────────────────────────────
  section('1. Module 12 — course profile + hole data');
  const { data: course, error: cErr } = await db.from('courses')
    .insert({ name: COURSE_NAME, city: 'Mandeville', state: 'LA', total_holes: 18, organizer_id: organizer.id, profile_status: 'draft' })
    .select().single();
  ok(!cErr && !!course, 'created course', cErr?.message ?? course?.id);
  if (!course) return finish();

  const holeRows = Array.from({ length: 18 }, (_, i) => ({
    course_id: course.id, hole_number: i + 1,
    par: [4, 5, 3, 4, 4, 5, 3, 4, 4, 4, 4, 3, 4, 5, 4, 4, 3, 5][i],
    handicap: i + 1,
    tee_yardages: { blue: 385, white: 355, red: 280 },
  }));
  const { error: hErr } = await db.from('course_holes').insert(holeRows);
  ok(!hErr, 'seeded 18 holes', hErr?.message ?? '');

  // ── 2. Tournaments + registrations ────────────────────────────────────────
  section('2. Tournaments + registrations');
  const mkTournament = async (name: string) => db.from('tournaments').insert({
    name, organizer_id: organizer.id, course_id: course.id,
    event_date: '2026-09-15', format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select().single();

  const { data: tSource, error: tsErr } = await mkTournament(T_SOURCE);
  const { data: tTarget, error: ttErr } = await mkTournament(T_TARGET);
  ok(!tsErr && !!tSource, 'created SOURCE tournament (where players opt in)', tsErr?.message ?? '');
  ok(!ttErr && !!tTarget, 'created TARGET tournament (the one that notifies)', ttErr?.message ?? '');
  if (!tSource || !tTarget) return finish();

  // 10 players register for SOURCE. Distances are chosen to exercise the
  // radius ladder: 8 near, 1 in the 15–25 ring, 1 in the 25–35 ring.
  const PLAYERS = [
    ...Array.from({ length: 8 }, (_, i) => ({ n: `Near ${i + 1}`, mi: 5, cause: 'youth education' })),
    { n: 'Ring 20mi', mi: 20, cause: 'youth education' },
    { n: 'Ring 30mi', mi: 30, cause: 'veterans' },
  ];
  const regs: { id: string; profileId: string; name: string; mi: number; cause: string }[] = [];
  for (const [i, p] of PLAYERS.entries()) {
    const { data: r, error } = await db.from('registrations').insert({
      tournament_id: tSource.id,
      contact_email: `zzz-e2e-player-${i}-${Date.now()}@${EMAIL_DOMAIN}`,
      contact_name: `${TAG} ${p.n}`,
      registration_type: 'single', total_amount_cents: 16500, payment_status: 'paid',
      players: [{ name: `${TAG} ${p.n}`, email: '' }],
    }).select('id').single();
    if (error || !r) { ok(false, `registered player ${p.n}`, error?.message); continue; }
    regs.push({ id: r.id, profileId: '', name: p.n, mi: p.mi, cause: p.cause });
  }
  ok(regs.length === 10, 'registered 10 players to SOURCE', `${regs.length}/10`);

  // The identity-matching trigger is AFTER INSERT, so the INSERT's own RETURNING
  // clause still shows player_profile_id as null — re-read to pick it up.
  const { data: linked } = await db.from('registrations').select('id, player_profile_id').in('id', regs.map((r) => r.id));
  for (const row of linked ?? []) {
    const target = regs.find((r) => r.id === row.id);
    if (target) target.profileId = (row.player_profile_id as string) ?? '';
  }
  ok(regs.every((r) => !!r.profileId), 'every registration got a player_profile (matching trigger fired)',
    `${regs.filter((r) => r.profileId).length}/${regs.length} linked`);

  // Course centroid is derived from real GPS tracks; without these the counts
  // API correctly reports "course not located" and matches nobody.
  // gps_tracks.foursome_id is NOT NULL and references registrations(id).
  const trackRows = Array.from({ length: 12 }, () => ({
    tournament_id: tSource.id, course_id: course.id, foursome_id: regs[0].id,
    lat: COURSE_AT.lat, lng: COURSE_AT.lng, recorded_at: new Date().toISOString(),
  }));
  const { error: gErr } = await db.from('gps_tracks').insert(trackRows);
  ok(!gErr, 'seeded GPS tracks so the course has a resolvable location', gErr?.message ?? '');

  // ── 3. Module 7 — opt-in / decline ────────────────────────────────────────
  section('3. Module 7 — TourneyCircle opt-in');
  for (const r of regs) {
    const { lat, lng } = atMiles(r.mi);
    const { status } = await call('/api/circle/opt-in', {
      method: 'POST',
      body: JSON.stringify({ registrationId: r.id, radiusMiles: 25, homeLat: lat, homeLng: lng, causes: [r.cause], cadenceDays: 10 }),
    });
    if (status !== 200) ok(false, `opt-in for ${r.name}`, `HTTP ${status}`);
  }
  const { count: memberCount } = await db.from('tourneycircle_members')
    .select('id', { count: 'exact', head: true }).in('player_profile_id', regs.map((r) => r.profileId));
  ok(memberCount === 10, 'all 10 opt-ins stored', `${memberCount}/10`);

  // Decline path: recorded so this player is never prompted again.
  const declineReg = regs[9];
  const { status: dStatus, data: dData } = await call('/api/circle/opt-in', {
    method: 'POST', body: JSON.stringify({ registrationId: declineReg.id, decline: true }),
  });
  ok(dStatus === 200 && dData.declined === true, 'decline recorded');
  const { data: declineRow } = await db.from('tourneycircle_declines').select('id').eq('player_profile_id', declineReg.profileId).maybeSingle();
  ok(!!declineRow, 'decline persisted to tourneycircle_declines');

  // Preferences read-back (the participant dashboard).
  const { data: prefs } = await call(`/api/circle/opt-in?reg=${regs[0].id}`);
  ok(prefs.optedIn === true && prefs.radiusMiles === 25, 'player can read back their own preferences');
  ok(Array.isArray(prefs.causes) && (prefs.causes as string[]).includes('youth education'), 'cause preferences round-trip');

  // ── 4. Module 10 — behavioral suppression inputs ──────────────────────────
  section('4. Module 10 — behavioral suppression');
  // (a) already registered for TARGET  (b) already visited TARGET's page
  const suppressedByReg = regs[0];
  const { data: dupReg } = await db.from('registrations').insert({
    tournament_id: tTarget.id, contact_email: `zzz-e2e-dup-${Date.now()}@${EMAIL_DOMAIN}`,
    contact_name: `${TAG} ${suppressedByReg.name}`, registration_type: 'single',
    total_amount_cents: 16500, payment_status: 'paid',
    players: [{ name: `${TAG} ${suppressedByReg.name}`, email: '' }],
  }).select('id').single();
  // The AFTER INSERT identity trigger matches on email and would overwrite any
  // player_profile_id passed to insert(), so bind it to the intended player
  // afterwards — this simulates the same person registering for TARGET too.
  if (dupReg) await db.from('registrations').update({ player_profile_id: suppressedByReg.profileId }).eq('id', dupReg.id);
  const { data: dupCheck } = await db.from('registrations').select('player_profile_id').eq('id', dupReg!.id).maybeSingle();
  ok(dupCheck?.player_profile_id === suppressedByReg.profileId, 'a Circle member also registered for TARGET directly');

  const suppressedByVisit = regs[1];
  const { data: visitSend } = await db.from('tourneycircle_sends').insert({
    player_profile_id: suppressedByVisit.profileId, tournament_id: tTarget.id,
  }).select('visit_token').single();
  ok(!!visitSend?.visit_token, 'send row issued an opaque visit_token (037)');
  const { status: vStatus } = await call('/api/circle/visit', {
    method: 'POST', body: JSON.stringify({ token: visitSend!.visit_token }),
  });
  ok(vStatus === 200, 'visit recorded via token');
  const { data: visitRow } = await db.from('tourneycircle_visits').select('id')
    .eq('player_profile_id', suppressedByVisit.profileId).eq('tournament_id', tTarget.id).maybeSingle();
  ok(!!visitRow, 'visit persisted → this player is now suppressed for TARGET');

  // ── 5. Module 22 — aggregate counts dashboard ─────────────────────────────
  section('5. Module 22 — aggregate counts (organizer session)');
  const circle15 = await call(`/api/tournament/${tTarget.id}/circle?radius=15`, { headers: bearer(organizer.jwt) });
  ok(circle15.status === 200, 'organizer can read their own tournament counts', `HTTP ${circle15.status}`);
  ok(circle15.data.courseLocated === true, 'course location resolved from GPS tracks');

  // 8 near players − 2 suppressed = 6 reachable inside 15mi.
  const matched = circle15.data.matched as { total: number; individual: number };
  ok(matched?.total === 6, 'matched count excludes registered + visited players', `got ${matched?.total}, expected 6`);

  const byRadius = circle15.data.byRadius as { radiusMiles: number; value: number; suppressed: boolean }[];
  ok(Array.isArray(byRadius) && byRadius.length === RADIUS_OPTIONS.length, 'byRadius covers every radius option');
  const r15 = byRadius.find((r) => r.radiusMiles === 15)!;
  const r25 = byRadius.find((r) => r.radiusMiles === 25)!;
  ok(!r15.suppressed && r15.value === 6, '15mi discloses (6 ≥ threshold)', JSON.stringify(r15));
  // 25mi raw is 7; 7−6=1 would name the single player in that ring.
  ok(r25.suppressed, '25mi SUPPRESSED — its increment over 15mi is a single person', JSON.stringify(r25));

  const byCause = circle15.data.byCause as { cause: string; value: number }[];
  ok(byCause.some((c) => c.cause === 'youth education' && c.value === 6), 'common cause reported', JSON.stringify(byCause));
  ok(!byCause.some((c) => c.value < MIN_DISCLOSABLE_COUNT), 'no cause bucket below the threshold is listed');

  // ── 6. Privacy firewall — attack the aggregate surface ────────────────────
  section('6. Privacy firewall — attacks from a real organizer session');

  // 6a. The response body itself must carry nothing individual.
  const FORBIDDEN = ['player_profile_id', 'playerProfileId', 'home_lat', 'home_lng', 'email', '@', 'contact_name', 'visit_token'];
  const leaked = FORBIDDEN.filter((k) => circle15.raw.includes(k));
  ok(leaked.length === 0, 'counts response contains no individual identifiers', leaked.length ? `LEAKED ${leaked.join(', ')}` : 'scanned raw body');

  // 6b. Radius-walking must not let the organizer difference the ladder.
  const walked: { r: number; total: number; suppressed: boolean }[] = [];
  for (const r of RADIUS_OPTIONS) {
    const res = await call(`/api/tournament/${tTarget.id}/circle?radius=${r}`, { headers: bearer(organizer.jwt) });
    walked.push({ r, total: (res.data.matched as { total: number }).total, suppressed: res.data.matchedSuppressed === true });
  }
  console.log(`     walked: ${walked.map((w) => `${w.r}mi=${w.suppressed ? '—' : w.total}`).join('  ')}`);
  const visible = walked.filter((w) => !w.suppressed);
  const diffLeaks: string[] = [];
  for (let a = 0; a < visible.length; a++) {
    for (let b = a + 1; b < visible.length; b++) {
      const d = visible[b].total - visible[a].total;
      if (d > 0 && d < MIN_DISCLOSABLE_COUNT) diffLeaks.push(`${visible[a].r}→${visible[b].r}=${d}`);
    }
  }
  ok(diffLeaks.length === 0, 'walking every radius yields no sub-threshold difference', diffLeaks.join(', ') || 'all pairs checked');

  // 6c. Cross-tenant: a different organizer must not read these counts.
  const cross = await call(`/api/tournament/${tTarget.id}/circle?radius=25`, { headers: bearer(outsider.jwt) });
  ok(cross.status === 403, 'a different organizer is refused (403)', `HTTP ${cross.status}`);
  const noAuth = await call(`/api/tournament/${tTarget.id}/circle?radius=25`);
  ok(noAuth.status === 401, 'unauthenticated read is refused (401)', `HTTP ${noAuth.status}`);

  // 6d. Roster dump — was an unauthenticated names + registration-id leak.
  const roster = await call(`/api/registrations?tournament_id=${tTarget.id}`);
  ok(roster.status === 401, 'unauthenticated roster dump refused (401)', `HTTP ${roster.status}`);
  const rosterCross = await call(`/api/registrations?tournament_id=${tTarget.id}`, { headers: bearer(outsider.jwt) });
  ok(rosterCross.status === 403, 'roster refused to a different organizer (403)', `HTTP ${rosterCross.status}`);

  // 6e. Geography oracle — the response must not vary with supplied coordinates.
  const probe = async (lat: number, lng: number) => (await call('/api/circle/opt-in', {
    method: 'POST',
    body: JSON.stringify({ registrationId: regs[2].id, radiusMiles: 15, homeLat: lat, homeLng: lng }),
  })).data.memberCountNearby;
  // Sequential on purpose: this probe WRITES (opt-in upserts the member) and
  // then reads a count. Running the three in parallel raced the write against
  // the read and produced a nondeterministic ±1 that looked like a leak.
  const probes: unknown[] = [];
  for (const [lat, lng] of [[30.41, -90.09], [40.71, -74.0], [51.5, -0.12]] as const) {
    probes.push(await probe(lat, lng));
  }
  ok(new Set(probes.map((p) => JSON.stringify(p))).size === 1,
    'member count does not vary with attacker-supplied coordinates', JSON.stringify(probes));
  // Those probes go through the real opt-in path, which legitimately writes the
  // supplied location — so the probed player is now sitting in London. Put them
  // back before the send phase measures the population.
  const home = atMiles(regs[2].mi);
  await db.from('tourneycircle_members')
    .update({ home_lat: home.lat, home_lng: home.lng })
    .eq('player_profile_id', regs[2].profileId);

  // 6f. Forged visit — the old attack named a player_profile_id directly.
  const forgedById = await call('/api/circle/visit', {
    method: 'POST', body: JSON.stringify({ tournamentId: tTarget.id, playerProfileId: regs[3].profileId }),
  });
  ok(forgedById.status === 400, 'visit by caller-named player_profile_id refused (400)', `HTTP ${forgedById.status}`);
  const { data: forgedRow } = await db.from('tourneycircle_visits').select('id')
    .eq('player_profile_id', regs[3].profileId).eq('tournament_id', tTarget.id).maybeSingle();
  ok(!forgedRow, 'no suppression row was forged');

  const forgedByToken = await call('/api/circle/visit', { method: 'POST', body: JSON.stringify({ token: randomUUID() }) });
  ok(forgedByToken.status === 200 && forgedByToken.data.ok === true, 'unknown visit token is indistinguishable from a valid one');

  // 6g. Cross-tournament history must stay hidden from the browser client.
  const orgClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: bearer(organizer.jwt) } });
  const { error: colErr } = await orgClient.from('player_profiles').select('tournament_ids, registration_count').limit(1);
  ok(!!colErr, 'organizer JWT cannot select cross-tournament columns', colErr?.message ?? 'COLUMNS READABLE');
  for (const table of ['tourneycircle_members', 'tourneycircle_visits', 'tourneycircle_sends', 'tourneycircle_declines']) {
    const { data: rows, error } = await orgClient.from(table).select('*').limit(1);
    ok(!!error || (rows?.length ?? 0) === 0, `organizer JWT cannot read ${table}`, error?.message ?? `returned ${rows?.length} row(s)`);
  }

  // ── 7. Module 10 — the $29 send ───────────────────────────────────────────
  section('7. Module 10 — notification send');
  const sendSmall = await call(`/api/tournament/${tTarget.id}/circle`, {
    method: 'POST', headers: bearer(organizer.jwt), body: JSON.stringify({ radiusMiles: 15 }),
  });
  // 6 reachable at 15mi ≥ threshold, so this one should go through.
  ok(sendSmall.status === 200, 'send accepted when enough players are reachable', `HTTP ${sendSmall.status} ${sendSmall.raw.slice(0, 120)}`);
  ok(sendSmall.data.reached === 6, 'reached count matches the eligible population', `got ${sendSmall.data.reached}`);

  const { count: sendRowCount } = await db.from('tourneycircle_sends')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', tTarget.id);
  ok((sendRowCount ?? 0) >= 6, 'per-player send rows written (cadence + Module 25 tokens)', `${sendRowCount} rows`);

  // Cadence: an immediate second send has nobody outside their window.
  const sendAgain = await call(`/api/tournament/${tTarget.id}/circle`, {
    method: 'POST', headers: bearer(organizer.jwt), body: JSON.stringify({ radiusMiles: 15 }),
  });
  ok(sendAgain.status === 400, 'immediate re-send blocked by cadence enforcement', `HTTP ${sendAgain.status}`);
  ok(typeof sendAgain.data.error === 'string' && !/cadence/i.test(sendAgain.data.error as string),
    'refusal message does not reveal whether anyone was in range', String(sendAgain.data.error).slice(0, 80));

  // Threshold floor: a radius with nobody reachable is refused, same message.
  const { data: farT } = await db.from('tournaments').insert({
    name: `${TAG} FAR — SAFE TO DELETE`, organizer_id: organizer.id, course_id: course.id,
    event_date: '2026-09-16', format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select().single();
  if (farT) {
    // Everyone is already inside their cadence window from the send above, so
    // this also confirms the two refusal paths are indistinguishable.
    const sendFar = await call(`/api/tournament/${farT.id}/circle`, {
      method: 'POST', headers: bearer(organizer.jwt), body: JSON.stringify({ radiusMiles: 15 }),
    });
    ok(sendFar.status === 400, 'send refused below the disclosure floor', `HTTP ${sendFar.status}`);
    ok(sendFar.data.error === sendAgain.data.error, 'both refusal reasons return an identical message');
  }

  // ── 8. Module 12 — delegated pro access ───────────────────────────────────
  section('8. Module 12 — delegated golf-pro access');
  const proEmail = `zzz-e2e-pro-${Date.now()}@${EMAIL_DOMAIN}`;
  const year = new Date().getFullYear();
  const issue = await call(`/api/course/${course.id}/pro-access`, {
    method: 'POST', headers: bearer(organizer.jwt), body: JSON.stringify({ email: proEmail, year }),
  });
  ok(issue.status === 200, 'organizer issued a pro access grant', `HTTP ${issue.status} ${issue.raw.slice(0, 120)}`);
  ok(issue.data.password === issuedPassword(COURSE_NAME, year), 'password follows the golfCourseNameYear format', String(issue.data.password));
  const loginUrl = String(issue.data.loginUrl ?? '');
  const linkToken = loginUrl.split('/course/pro/')[1] ?? '';
  ok(!!linkToken, 'grant returned a unique login link');

  const crossIssue = await call(`/api/course/${course.id}/pro-access`, {
    method: 'POST', headers: bearer(outsider.jwt), body: JSON.stringify({ email: proEmail }),
  });
  ok(crossIssue.status === 403, 'a different organizer cannot issue access to this course (403)', `HTTP ${crossIssue.status}`);

  const badLogin = await call('/api/course/pro', {
    method: 'POST', body: JSON.stringify({ action: 'login', linkToken, email: proEmail, password: 'wrong-password' }),
  });
  ok(badLogin.status === 401, 'wrong password rejected (401)', `HTTP ${badLogin.status}`);
  const wrongEmail = await call('/api/course/pro', {
    method: 'POST', body: JSON.stringify({ action: 'login', linkToken, email: `other@${EMAIL_DOMAIN}`, password: String(issue.data.password) }),
  });
  ok(wrongEmail.status === 401, 'wrong email rejected (401)');
  ok(badLogin.data.error === wrongEmail.data.error, 'both credential failures return the same message');

  const login = await call('/api/course/pro', {
    method: 'POST', body: JSON.stringify({ action: 'login', linkToken, email: proEmail, password: String(issue.data.password) }),
  });
  ok(login.status === 200, 'pro signed in with the issued credentials', `HTTP ${login.status}`);
  const proSession = String(login.data.sessionToken ?? '');
  ok(!!proSession, 'pro received a session token');
  ok(Array.isArray(login.data.holes) && (login.data.holes as unknown[]).length === 18, 'pro sees all 18 holes');

  const save = await call('/api/course/pro', {
    method: 'POST',
    body: JSON.stringify({
      action: 'save', sessionToken: proSession,
      hole: { holeNumber: 3, par: 3, handicap: 3, description: 'Elevated green', shapeTags: ['elevated_green'], teeYardages: { blue: 171 } },
    }),
  });
  ok(save.status === 200, 'pro saved a hole', `HTTP ${save.status}`);
  const { data: savedHole } = await db.from('course_holes').select('par, tee_yardages, shape_tags').eq('course_id', course.id).eq('hole_number', 3).maybeSingle();
  ok((savedHole?.tee_yardages as Record<string, number>)?.blue === 171, "the pro's edit reached the database", JSON.stringify(savedHole?.tee_yardages));
  ok((savedHole?.shape_tags as string[])?.includes('elevated_green'), 'shape tags persisted (migration 035)');

  const badSession = await call('/api/course/pro', {
    method: 'POST', body: JSON.stringify({ action: 'save', sessionToken: randomUUID(), hole: { holeNumber: 4, par: 3 } }),
  });
  ok(badSession.status === 401, 'a forged pro session cannot save (401)', `HTTP ${badSession.status}`);

  const status = await call(`/api/course/${course.id}/pro-access`, { headers: bearer(organizer.jwt) });
  ok(status.data.active === true, 'organizer sees the grant as active (their view flips to read-only)');
  ok(!('password' in status.data) && !status.raw.includes(String(issue.data.password)),
    'the password is never returned again after issuing');

  const revoke = await call(`/api/course/${course.id}/pro-access`, { method: 'DELETE', headers: bearer(organizer.jwt) });
  ok(revoke.status === 200, 'organizer revoked access');
  const afterRevoke = await call('/api/course/pro', {
    method: 'POST', body: JSON.stringify({ action: 'save', sessionToken: proSession, hole: { holeNumber: 5, par: 4 } }),
  });
  ok(afterRevoke.status === 401, "the pro's session dies with the grant (401)", `HTTP ${afterRevoke.status}`);

  console.log(`\nTest entities left in place. Run: npx tsx scripts/e2e-phase-e.ts purge`);
  finish();
}

// ── Purge ───────────────────────────────────────────────────────────────────
async function purge() {
  console.log('Purging ZZZ E2E PHASE-E entities…');

  const { data: tournaments } = await db.from('tournaments').select('id, name').ilike('name', `${TAG}%`);
  const tIds = (tournaments ?? []).map((t) => t.id);

  // Player profiles are reachable only through the test registrations, and are
  // scoped by the throwaway email domain so a real profile can never match.
  const { data: regRows } = tIds.length
    ? await db.from('registrations').select('player_profile_id').in('tournament_id', tIds)
    : { data: [] as { player_profile_id: string | null }[] };
  const profileIds = [...new Set((regRows ?? []).map((r) => r.player_profile_id).filter((x): x is string => !!x))];

  const { data: testProfiles } = profileIds.length
    ? await db.from('player_profiles').select('id, email').in('id', profileIds)
    : { data: [] as { id: string; email: string | null }[] };
  const safeProfileIds = (testProfiles ?? []).filter((p) => p.email?.endsWith(EMAIL_DOMAIN)).map((p) => p.id);
  const unsafe = (testProfiles ?? []).length - safeProfileIds.length;
  if (unsafe > 0) console.log(`  !! ${unsafe} linked profile(s) are NOT test emails — leaving them untouched`);

  for (const table of ['tourneycircle_visits', 'tourneycircle_sends', 'tourneycircle_members', 'tourneycircle_declines']) {
    if (!safeProfileIds.length) continue;
    const { error } = await db.from(table).delete().in('player_profile_id', safeProfileIds);
    console.log(error ? `  !! ${table}: ${error.message}` : `  cleared ${table}`);
  }
  if (safeProfileIds.length) {
    await db.from('registrations').update({ player_profile_id: null }).in('player_profile_id', safeProfileIds);
    const { error } = await db.from('player_profiles').delete().in('id', safeProfileIds);
    console.log(error ? `  !! player_profiles: ${error.message}` : `  deleted ${safeProfileIds.length} test player profile(s)`);
  }

  for (const id of tIds) {
    await db.from('gps_tracks').delete().eq('tournament_id', id);
    const { error } = await db.from('tournaments').delete().eq('id', id);
    console.log(error ? `  !! tournament ${id}: ${error.message}` : `  deleted tournament ${id}`);
  }

  const { data: courses } = await db.from('courses').select('id').eq('name', COURSE_NAME);
  for (const c of courses ?? []) {
    await db.from('course_pro_access').delete().eq('course_id', c.id);
    await db.from('gps_tracks').delete().eq('course_id', c.id);
    const { error } = await db.from('courses').delete().eq('id', c.id); // cascades course_holes
    console.log(error ? `  !! course ${c.id}: ${error.message}` : `  deleted course ${c.id}`);
  }

  // Throwaway auth users.
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  let removed = 0;
  for (const u of users?.users ?? []) {
    if (u.email?.endsWith(EMAIL_DOMAIN)) { await db.auth.admin.deleteUser(u.id); removed++; }
  }
  console.log(`  deleted ${removed} test auth user(s)`);

  const { data: leftT } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  const { data: leftC } = await db.from('courses').select('id').eq('name', COURSE_NAME);
  console.log(`Remaining: ${leftT?.length ?? 0} tournament(s), ${leftC?.length ?? 0} course(s)`);
  if ((leftT?.length ?? 0) + (leftC?.length ?? 0) > 0) process.exit(1);
}

function finish() {
  console.log(`\n${failures === 0 ? '✅ PHASE E — ALL CHECKS PASSED' : `❌ PHASE E — ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === 'run') run().catch((e) => { console.error(e); process.exit(1); });
else if (mode === 'purge') purge().catch((e) => { console.error(e); process.exit(1); });
else { console.log('usage: npx tsx scripts/e2e-phase-e.ts run|purge'); process.exit(1); }
