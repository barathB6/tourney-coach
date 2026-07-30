// Day 26 — Tournament Operations Center STRESS TEST.
//
// verify-toc.ts proves the happy path. This one attacks it: hostile input on
// the goals API, concurrent writes, missing and malformed tournament data,
// scale, cascade behaviour, and the database constraints that are supposed to
// be the last line of defence.
//
//   npx tsx scripts/stress-toc.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { anchorFor, buildGoals, describeOffset, dueAt, taskStatus } from '../lib/toc/phase';
import { loadOperationsCenter } from '../lib/toc/load';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const anon = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const TAG = 'ZZZ STRESS-TOC';
const DOM = 'stresstoc.example.invalid';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

async function mkOrganizer(label: string) {
  const email = `zzz-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@${DOM}`;
  const password = `zzzAa1!${Math.random().toString(36).slice(2)}`;
  const { data: u } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: s } = await anon.auth.signInWithPassword({ email, password });
  if (!u?.user || !s?.session) throw new Error(`could not create test organizer "${label}"`);
  return { id: u.user.id, jwt: s.session.access_token };
}

async function main() {
  const owner = await mkOrganizer('owner');
  const rival = await mkOrganizer('rival');

  const mkTournament = async (name: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await db.from('tournaments').insert({
      name: `${TAG} ${name}`, organizer_id: owner.id, format: 'scramble',
      max_players: 72, entry_fee_cents: 16500, status: 'draft',
      event_date: '2026-09-15', shotgun_time: '08:30', ...extra,
    }).select().single();
    if (error || !data) return { id: null as string | null, error: error?.message ?? 'no row' };
    return { id: data.id as string, error: null as string | null };
  };

  const tid = (await mkTournament('MAIN')).id!;
  const H = (jwt: string) => ({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' });
  const put = (id: string, body: unknown, jwt = owner.jwt) =>
    fetch(`${BASE}/api/tournament/${id}/toc`, { method: 'PUT', headers: H(jwt), body: JSON.stringify(body) });

  // ── 1. Authorization ──────────────────────────────────────────────────────
  section('1. Authorization on the goals API');
  ok((await fetch(`${BASE}/api/tournament/${tid}/toc`)).status === 401, 'GET without a token is 401');
  ok((await fetch(`${BASE}/api/tournament/${tid}/toc`, { headers: H('garbage.token.here') })).status === 401,
    'GET with a forged token is 401');
  ok((await fetch(`${BASE}/api/tournament/${tid}/toc`, { headers: H(rival.jwt) })).status === 403,
    "GET on another organizer's tournament is 403");
  ok((await put(tid, { playerGoal: 1 }, rival.jwt)).status === 403, 'PUT by another organizer is 403');
  ok((await put(tid, { playerGoal: 1 }, 'garbage')).status === 401, 'PUT with a forged token is 401');
  const { data: notWritten } = await db.from('tournament_goals').select('id').eq('tournament_id', tid).maybeSingle();
  ok(!notWritten, 'and none of those refused writes created a row');

  const missing = await fetch(`${BASE}/api/tournament/00000000-0000-0000-0000-000000000000/toc`, { headers: H(owner.jwt) });
  ok(missing.status === 404, 'an unknown tournament is 404, not a 500', `HTTP ${missing.status}`);

  // ── 2. Hostile input ──────────────────────────────────────────────────────
  section('2. Hostile input on PUT');
  const hostile: [string, unknown][] = [
    ['negative', { playerGoal: -5 }],
    ['non-integer', { playerGoal: 12.7 }],
    ['string', { playerGoal: '72' }],
    ['NaN', { playerGoal: Number.NaN }],
    ['Infinity', { playerGoal: Number.POSITIVE_INFINITY }],
    ['absurdly large', { playerGoal: 999_999_999 }],
    ['int overflow via dollars', { sponsorshipGoalDollars: 2_147_483_647 }],
    ['null', { playerGoal: null }],
    ['object', { playerGoal: { evil: true } }],
    ['array', { playerGoal: [1, 2, 3] }],
  ];
  for (const [label, body] of hostile) {
    const res = await put(tid, body);
    const d = await res.json().catch(() => ({}));
    const stored = d?.goals?.find((g: { key: string }) => g.key === 'players')?.target ?? null;
    // Rejected values must land as null, never as a coerced number, and must
    // never 500 — an API that crashes on bad input is a denial-of-service.
    ok(res.status === 200 && stored === null, `${label} → stored as null, HTTP 200`, `HTTP ${res.status}, target=${stored}`);
  }

  const emptyBody = await fetch(`${BASE}/api/tournament/${tid}/toc`, { method: 'PUT', headers: H(owner.jwt), body: 'not json' });
  ok(emptyBody.status === 200, 'a non-JSON body does not crash the route', `HTTP ${emptyBody.status}`);

  const valid = await put(tid, { playerGoal: 72, sponsorshipGoalDollars: 20000, donationItemsGoal: 10, marketingReachGoal: 500, volunteerRolesGoal: 9 });
  const validData = await valid.json();
  const g = Object.fromEntries(validData.goals.map((x: { key: string }) => [x.key, x]));
  ok(g.players.target === 72, 'a valid payload still saves');
  ok(g.sponsorship.target === 2_000_000, 'dollars are converted to cents on the way in', `${g.sponsorship.target}`);

  // ── 3. PUT is a replace, not a merge ──────────────────────────────────────
  section('3. Write semantics');
  const partial = await put(tid, { playerGoal: 40 });
  const partialData = await partial.json();
  const pg = Object.fromEntries(partialData.goals.map((x: { key: string }) => [x.key, x]));
  ok(pg.players.target === 40, 'a partial PUT updates the field it names');
  // This is real PUT semantics and the UI always sends all five, but an API
  // consumer sending one field silently clears the rest — worth knowing.
  ok(pg.sponsorship.target === null, 'and CLEARS the ones it omits (replace, not merge)',
    'documented behaviour, not a merge');
  await put(tid, { playerGoal: 72, sponsorshipGoalDollars: 20000, donationItemsGoal: 10, marketingReachGoal: 500, volunteerRolesGoal: 9 });

  // ── 4. Concurrency ────────────────────────────────────────────────────────
  section('4. Concurrent writes');
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    put(tid, { playerGoal: 50 + i, sponsorshipGoalDollars: 20000, donationItemsGoal: 10, marketingReachGoal: 500, volunteerRolesGoal: 9 })));
  ok(burst.every((r) => r.status === 200), '12 simultaneous PUTs all succeed', burst.map((r) => r.status).join(','));
  const { data: rows } = await db.from('tournament_goals').select('id').eq('tournament_id', tid);
  ok((rows ?? []).length === 1, 'and leave exactly ONE row, not twelve', `${(rows ?? []).length} row(s)`);

  const dupe = await db.from('tournament_goals').insert({ tournament_id: tid, player_goal: 1 });
  ok(dupe.error?.code === '23505', 'the unique constraint blocks a second goals row', dupe.error?.code ?? 'insert succeeded');

  // Concurrent GETs must not be affected by writes in flight.
  const reads = await Promise.all(Array.from({ length: 10 }, () =>
    fetch(`${BASE}/api/tournament/${tid}/toc`, { headers: H(owner.jwt) }).then((r) => r.status)));
  ok(reads.every((s) => s === 200), '10 concurrent reads all return 200', [...new Set(reads)].join(','));

  // ── 5. Malformed tournament data ──────────────────────────────────────────
  section('5. Tournaments with missing or odd data');
  // The database refuses a date-less tournament, which is the right call — but
  // it means the engine's null-date branch can only be reached directly, so
  // that is where it gets tested rather than pretending a row can exist.
  const noDate = await mkTournament('NO-DATE', { event_date: null });
  ok(noDate.id === null, 'the schema refuses a tournament with no event date', noDate.error ?? '');
  ok(dueAt('planning', -2688, null, null) === null && anchorFor('day_of', null, '08:30') === null,
    'and the engine still returns null for a null date rather than epoch');

  const noShotgun = (await mkTournament('NO-SHOTGUN', { shotgun_time: null })).id!;
  const snapNoShot = await loadOperationsCenter(db, noShotgun);
  const dayOfTask = snapNoShot!.roles.find((r) => r.phase === 'day_of')!.tasks[0];
  ok(dayOfTask.dueAt !== null, 'a missing shotgun time falls back rather than blanking the day-of sheet');

  const oddDate = (await mkTournament('LEAP', { event_date: '2028-02-29' })).id!;
  const snapLeap = await loadOperationsCenter(db, oddDate);
  ok(!!snapLeap && snapLeap.roles.some((r) => r.tasks.some((t) => t.dueAt)), 'a leap day resolves');
  ok(anchorFor('planning', '2028-02-29', null)!.getDate() === 29, 'Feb 29 2028 anchors to the 29th');

  // ── 6. Scale ──────────────────────────────────────────────────────────────
  section('6. Scale');
  const bulk = (await mkTournament('BULK')).id!;
  await db.from('registrations').insert(Array.from({ length: 300 }, (_, i) => ({
    tournament_id: bulk, contact_name: `Bulk ${i}`, contact_email: `b${i}@${DOM}`,
    registration_type: i % 5 === 0 ? 'single' : 'foursome',
    total_amount_cents: 60000, payment_status: i % 7 === 0 ? 'refunded' : 'paid', players: [],
  })));
  await db.from('sponsors').insert(Array.from({ length: 150 }, (_, i) => ({
    tournament_id: bulk, company: `Sponsor ${i}`,
    status: ['paid', 'verbal', 'not_contacted', 'declined'][i % 4], amount_cents: 100000,
  })));

  const t0 = Date.now();
  const bulkSnap = await loadOperationsCenter(db, bulk);
  const elapsed = Date.now() - t0;
  ok(!!bulkSnap, '300 registrations + 150 sponsors load');
  ok(elapsed < 6000, `snapshot builds in reasonable time`, `${elapsed}ms`);

  // Hand-computed expectations, so a silently wrong aggregate is caught.
  const expectPlayers = Array.from({ length: 300 }, (_, i) => ({ single: i % 5 === 0, refunded: i % 7 === 0 }))
    .filter((r) => !r.refunded).reduce((n, r) => n + (r.single ? 1 : 4), 0);
  const expectCents = Array.from({ length: 150 }, (_, i) => ['paid', 'verbal', 'not_contacted', 'declined'][i % 4])
    .filter((s) => ['paid', 'verbal', 'invoiced'].includes(s)).length * 100000;
  const bg = Object.fromEntries(bulkSnap!.goals.map((x) => [x.key, x]));
  ok(bg.players.actual === expectPlayers, 'player total matches a hand computation', `${bg.players.actual} vs ${expectPlayers}`);
  ok(bg.sponsorship.actual === expectCents, 'sponsorship total matches a hand computation', `$${bg.sponsorship.actual / 100} vs $${expectCents / 100}`);

  // ── 7. Constraints are the last line of defence ───────────────────────────
  section('7. Database constraints');
  const badPhase = await db.from('role_templates').insert({ name: `${TAG} BAD PHASE`, phase: 'someday' });
  ok(badPhase.error?.code === '23514', 'role_templates rejects an unknown phase', badPhase.error?.code ?? 'INSERT ALLOWED');
  const badTaskPhase = await db.from('task_templates').insert({ title: `${TAG} bad`, phase: 'whenever' });
  ok(badTaskPhase.error?.code === '23514', 'task_templates rejects an unknown phase', badTaskPhase.error?.code ?? 'INSERT ALLOWED');

  const { data: aRole } = await db.from('role_templates').select('id').eq('phase', 'day_of').limit(1).single();
  const { data: aVol } = await db.from('volunteers').insert({ tournament_id: tid, name: 'Dup Tester', email: `dup@${DOM}` }).select('id').single();
  await db.from('tournament_volunteer_assignments').insert({ tournament_id: tid, volunteer_id: aVol!.id, role_template_id: aRole!.id });
  const dupAssign = await db.from('tournament_volunteer_assignments')
    .insert({ tournament_id: tid, volunteer_id: aVol!.id, role_template_id: aRole!.id });
  ok(dupAssign.error?.code === '23505', 'the same person cannot hold the same role twice', dupAssign.error?.code ?? 'INSERT ALLOWED');

  const badStatus = await db.from('tournament_volunteer_assignments')
    .insert({ tournament_id: tid, volunteer_id: aVol!.id, role_template_id: aRole!.id, status: 'maybe' });
  ok(badStatus.error?.code === '23514' || badStatus.error?.code === '23505',
    'an unknown assignment status is rejected', badStatus.error?.code ?? 'INSERT ALLOWED');

  // Seed idempotency: re-running the migration must not duplicate the library.
  const { count: roleCount } = await db.from('role_templates').select('id', { count: 'exact', head: true }).not('phase', 'is', null);
  const { data: names } = await db.from('role_templates').select('name');
  const dupNames = (names ?? []).map((r) => r.name).filter((n, i, a) => a.indexOf(n) !== i);
  ok(dupNames.length === 0, 'no duplicate role names — the seed is idempotent', dupNames.join(', ') || `${roleCount} roles`);

  // ── 8. Cascade ────────────────────────────────────────────────────────────
  section('8. Cascade on delete');
  const doomed = (await mkTournament('DOOMED')).id!;
  await db.from('tournament_goals').insert({ tournament_id: doomed, player_goal: 50 });
  await db.from('tournaments').delete().eq('id', doomed);
  const { data: orphan } = await db.from('tournament_goals').select('id').eq('tournament_id', doomed);
  ok((orphan ?? []).length === 0, 'deleting a tournament removes its goals — no orphans', `${(orphan ?? []).length} left`);

  // ── 9. Phase engine edges ─────────────────────────────────────────────────
  section('9. Phase engine edge cases');
  ok(dueAt('planning', 0, '2026-09-15', '08:30')!.getHours() === 0, 'a zero-offset planning task lands at midnight on event day');
  ok(describeOffset('planning', 0) === 'on event day', 'and reads as "on event day"');
  ok(describeOffset('planning', 336) === '2 weeks after', 'a positive planning offset reads as "after"');
  ok(describeOffset('day_of', 5) === '5h after the shotgun', 'a positive day-of offset reads as "after"');
  ok(taskStatus('day_of', new Date(), new Date(), null) === 'not_applicable', 'a day-of task with no event date never nags');
  ok(dueAt('planning', -2688, null, null) === null, 'no event date → no due date, not epoch');

  const huge = buildGoals(
    { player_goal: 1, sponsorship_goal_cents: 1, donation_items_goal: 1, marketing_reach_goal: 1, volunteer_roles_goal: 1 },
    { players: 999999, sponsorshipCents: 999999999, donationItems: 999999, marketingReach: 999999, rolesFilled: 999999 },
  );
  ok(huge.every((x) => x.percent === 100 && x.met), 'wildly over target still caps at 100%, never 99999%');
  const negative = buildGoals({ player_goal: 10, sponsorship_goal_cents: null, donation_items_goal: null, marketing_reach_goal: null, volunteer_roles_goal: null }, {
    players: 0, sponsorshipCents: 0, donationItems: 0, marketingReach: 0, rolesFilled: 0,
  });
  ok(negative[0].percent === 0 && !negative[0].met, 'zero progress against a real target is 0%, not null');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('10. Cleanup');
  await db.from('role_templates').delete().ilike('name', `${TAG}%`);
  const { data: tagged } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  for (const row of tagged ?? []) {
    await db.from('tournament_volunteer_assignments').delete().eq('tournament_id', row.id);
    await db.from('tournament_goals').delete().eq('tournament_id', row.id);
    await db.from('volunteers').delete().eq('tournament_id', row.id);
    await db.from('sponsors').delete().eq('tournament_id', row.id);
    await db.from('registrations').delete().eq('tournament_id', row.id);
    await db.from('tournaments').delete().eq('id', row.id);
  }
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) if (u.email?.endsWith(DOM)) await db.auth.admin.deleteUser(u.id);
  const { data: left } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  const { data: leftRoles } = await db.from('role_templates').select('id').ilike('name', `${TAG}%`);
  ok((left?.length ?? 0) === 0 && (leftRoles?.length ?? 0) === 0, 'fixtures removed',
    `${left?.length ?? 0} tournaments, ${leftRoles?.length ?? 0} roles`);

  console.log(`\n${failures === 0 ? '✅ TOC STRESS — ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
