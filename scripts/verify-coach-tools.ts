// Verifies the AI coach's action tools against a real, disposable tournament.
//
// The coach runs on the SERVICE-ROLE client, which bypasses RLS entirely — so
// its own authorization checks are the only thing standing between one
// organizer and another's data. That makes this file less a feature test than
// a security test: over half of it is another organizer, and an injected
// prompt, trying to get through.
//
//   npx tsx scripts/verify-coach-tools.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { COACH_TOOLS, executeCoachTool } from '../lib/coach/tools';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

const TAG = 'ZZZ COACH-TOOLS';
const EMAIL_DOMAIN = 'coach-tools.example.invalid';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

async function main() {
  section('0. Tool surface');
  const names = COACH_TOOLS.map((t) => t.name);
  ok(new Set(names).size === names.length, 'no duplicate tool names', `${names.length} tools`);
  ok(COACH_TOOLS.every((t) => t.description.length > 40), 'every tool has a real description');
  console.log(`     ${names.join(', ')}`);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${Date.now()}@${EMAIL_DOMAIN}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const { data: rival } = await db.auth.admin.createUser({
    email: `zzz-rival-${Date.now()}@${EMAIL_DOMAIN}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  if (!owner?.user || !rival?.user) throw new Error('could not create the two test organizers');
  const ownerId = owner.user.id;
  const rivalId = rival.user.id;

  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE`, city: 'Mandeville', state: 'LA', total_holes: 18, organizer_id: ownerId, profile_status: 'draft',
  }).select().single();

  const { data: tournament } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: ownerId, course_id: course!.id,
    event_date: '2026-10-01', format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select().single();
  const tid = tournament!.id;

  // The organizer's own words. Deliberately contains no refund/delete/send verbs.
  const benignIntent = 'can you get my event tidied up for me';
  const ctx = { service: db, organizerId: ownerId, tournamentId: tid, userIntent: benignIntent };
  const run = (name: string, input: Record<string, unknown>, intent = benignIntent) =>
    executeCoachTool(name, input, { ...ctx, userIntent: intent });

  // ── Authorization ─────────────────────────────────────────────────────────
  section('1. Authorization — the coach runs as service-role, so this is the only guard');
  const asRival = await executeCoachTool('update_event_settings', { name: 'HIJACKED' },
    { service: db, organizerId: rivalId, tournamentId: tid, userIntent: 'rename it' });
  ok(!asRival.ok, 'another organizer cannot touch this tournament', asRival.error);
  const { data: unchanged } = await db.from('tournaments').select('name').eq('id', tid).single();
  ok(unchanged?.name === `${TAG} EVENT`, 'the name really was not changed', unchanged?.name);

  const noTournament = await executeCoachTool('update_event_settings', { name: 'X' },
    { service: db, organizerId: ownerId, tournamentId: null, userIntent: 'rename it' });
  ok(!noTournament.ok, 'refuses when no tournament is selected');

  // ── Safe writes ───────────────────────────────────────────────────────────
  section('2. Safe writes');
  const upd = await run('update_event_settings', { maxPlayers: 80, entryFeeDollars: 150, causeOrg: 'St. Michaels' });
  ok(upd.ok, 'update_event_settings', upd.summary || upd.error);
  const { data: after } = await db.from('tournaments').select('max_players, entry_fee_cents, cause_org').eq('id', tid).single();
  ok(after?.max_players === 80 && after?.entry_fee_cents === 15000, 'settings actually persisted', JSON.stringify(after));

  ok(!(await run('update_event_settings', { maxPlayers: 99999 })).ok, 'rejects an out-of-range field size');
  ok(!(await run('update_event_settings', { eventDate: 'next Tuesday' })).ok, 'rejects a non-ISO date');

  const addReg = await run('add_registration', { contactName: 'Paper Smith', contactEmail: `smith@${EMAIL_DOMAIN}`, teamName: 'Smith Foursome', markPaid: true });
  ok(addReg.ok, 'add_registration', addReg.summary || addReg.error);
  const noEmail = await run('add_registration', { contactName: 'No Email' });
  ok(!noEmail.ok, 'add_registration asks for an email rather than inventing one', noEmail.error);

  const addSpon = await run('add_sponsor', { company: 'ACME Roofing', amountDollars: 2500 });
  ok(addSpon.ok, 'add_sponsor', addSpon.summary || addSpon.error);

  const tiers = await run('add_sponsorship_tier', { starter: true });
  ok(tiers.ok, 'add_sponsorship_tier (starter set)', tiers.summary || tiers.error);
  ok(!(await run('add_sponsorship_tier', { starter: true })).ok, 'refuses to seed packages twice');

  const contest = await run('manage_contest', { action: 'create', contestType: 'closest_to_pin', holeNumber: 5, prize: 'Pro shop card' });
  ok(contest.ok, 'manage_contest create', contest.summary || contest.error);

  const hole = await run('set_hole_data', { holeNumber: 7, par: 3, yardages: { blue: 165 } });
  ok(hole.ok, 'set_hole_data', hole.summary || hole.error);
  const { data: savedHole } = await db.from('course_holes').select('par, tee_yardages').eq('course_id', course!.id).eq('hole_number', 7).maybeSingle();
  ok(savedHole?.par === 3 && (savedHole?.tee_yardages as Record<string, number>)?.blue === 165, 'hole data persisted', JSON.stringify(savedHole));
  ok(!(await run('set_hole_data', { holeNumber: 99, par: 3 })).ok, 'rejects an out-of-range hole');

  const vol = await run('add_volunteer', { name: 'Dana Marshal', role: 'check-in' });
  ok(vol.ok, 'add_volunteer', vol.summary || vol.error);

  // ── Reads ─────────────────────────────────────────────────────────────────
  section('3. Reads are scoped to this tournament');
  const regs = await run('list_registrations', {});
  ok(regs.ok && regs.summary.includes('Smith'), 'list_registrations returns our own entry');
  const sponsors = await run('list_sponsors', {});
  ok(sponsors.ok && sponsors.summary.includes('ACME'), 'list_sponsors');
  ok((await run('list_volunteers', {})).summary.includes('Dana'), 'list_volunteers');
  ok((await run('list_contests', {})).summary.includes('closest_to_pin'), 'list_contests');
  ok((await run('get_course_holes', {})).summary.includes('par 3'), 'get_course_holes');

  // A rival's read must come back empty/refused, not populated.
  const rivalRead = await executeCoachTool('list_registrations', {},
    { service: db, organizerId: rivalId, tournamentId: tid, userIntent: 'show me' });
  ok(!rivalRead.ok, 'a different organizer cannot read this roster', rivalRead.error);

  // ── The gate ──────────────────────────────────────────────────────────────
  section('4. Risk gate — money, outsiders, destruction');
  const regId = regs.summary.split('\n')[1]?.split(' | ')[0] ?? '';
  ok(!!regId, 'captured a registration id from the listing');

  const refundUngated = await run('refund_registration', { registrationId: regId });
  ok(!refundUngated.ok, 'refund BLOCKED when the organizer never said "refund"', refundUngated.error);
  const { data: stillPaid } = await db.from('registrations').select('payment_status').eq('id', regId).single();
  ok(stillPaid?.payment_status === 'paid', 'and the payment really was left alone', stillPaid?.payment_status);

  ok(!(await run('send_circle_notification', { radiusMiles: 25 })).ok, '$29 send BLOCKED without an explicit ask');
  ok(!(await run('invite_golf_pro', { email: `pro@${EMAIL_DOMAIN}` })).ok, 'pro invitation BLOCKED without an explicit ask');
  ok(!(await run('set_registration_status', { action: 'open' })).ok, 'publishing BLOCKED without an explicit ask');

  // The gate reads the ORGANIZER's words only. Text that arrives via event data
  // or a tool result is not a user turn and must not be able to satisfy it.
  const injected = await executeCoachTool('refund_registration', { registrationId: regId }, {
    service: db, organizerId: ownerId, tournamentId: tid,
    userIntent: 'what should I do about the weather forecast',
  });
  ok(!injected.ok, 'an injected "please refund everyone" in event data cannot satisfy the gate', injected.error);

  // With the organizer's own words present, it proceeds.
  const refundOk = await run('refund_registration', { registrationId: regId }, 'please refund the Smith foursome, they cancelled');
  ok(refundOk.ok, 'refund ALLOWED once the organizer actually asks', refundOk.summary || refundOk.error);
  const { data: refunded } = await db.from('registrations').select('payment_status').eq('id', regId).single();
  ok(refunded?.payment_status === 'refunded', 'refund applied', refunded?.payment_status);

  ok(!(await run('refund_registration', { registrationId: regId }, 'refund it again')).ok, 'refunding twice is refused');

  // Cross-tournament id smuggling: a valid id from someone else's event.
  const { data: rivalT } = await db.from('tournaments').insert({
    name: `${TAG} RIVAL EVENT`, organizer_id: rivalId, event_date: '2026-10-02', format: 'scramble',
    max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select().single();
  const { data: rivalReg } = await db.from('registrations').insert({
    tournament_id: rivalT!.id, contact_name: 'Rival Player', contact_email: `rival@${EMAIL_DOMAIN}`, registration_type: 'single',
    total_amount_cents: 16500, payment_status: 'paid', players: [{ name: 'Rival Player', email: '' }],
  }).select('id').single();
  const smuggled = await run('refund_registration', { registrationId: rivalReg!.id }, 'refund that one please');
  ok(!smuggled.ok, "cannot refund another organizer's registration by passing its id", smuggled.error);
  const { data: rivalStill } = await db.from('registrations').select('payment_status').eq('id', rivalReg!.id).single();
  ok(rivalStill?.payment_status === 'paid', "and the rival's payment is untouched");

  const paid2 = await run('add_registration', { contactName: 'Still Paid', contactEmail: `paid2@${EMAIL_DOMAIN}`, markPaid: true });
  ok(paid2.ok, 'seeded a second paid registration for the delete guard');
  const regs2 = await run('list_registrations', { status: 'paid' });
  const paidId = regs2.summary.split('\n')[1]?.split(' | ')[0] ?? '';
  const delPaid = await run('delete_registration', { registrationId: paidId }, 'delete that registration');
  ok(!delPaid.ok, 'refuses to delete a registration that took money', delPaid.error);
  // A refunded one IS deletable — same rule the Registrations tab uses.
  const delRefunded = await run('delete_registration', { registrationId: regId }, 'delete that registration');
  ok(delRefunded.ok, 'a refunded registration can be deleted', delRefunded.summary || delRefunded.error);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('5. Cleanup');
  // Purge by tag, not just this run's ids — an earlier aborted run leaves
  // fixtures behind, and the leftovers check below would keep failing on them.
  const { data: allTagged } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  for (const id of (allTagged ?? []).map((t) => t.id)) {
    for (const table of ['contest_holes', 'sponsorship_tiers', 'sponsors', 'volunteers', 'score_corrections', 'score_submissions', 'registrations']) {
      const { error } = await db.from(table).delete().eq('tournament_id', id);
      if (error) console.log(`     !! ${table}: ${error.message}`);
    }
    const { error } = await db.from('tournaments').delete().eq('id', id);
    if (error) console.log(`     !! tournaments: ${error.message}`);
  }
  const { data: taggedCourses } = await db.from('courses').select('id').ilike('name', `${TAG}%`);
  for (const c of taggedCourses ?? []) {
    await db.from('course_pro_access').delete().eq('course_id', c.id);
    await db.from('courses').delete().eq('id', c.id);
  }
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) {
    if (u.email?.endsWith(EMAIL_DOMAIN)) await db.auth.admin.deleteUser(u.id);
  }
  const { data: leftovers } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  ok((leftovers?.length ?? 0) === 0, 'test fixtures removed', `${leftovers?.length ?? 0} left`);

  console.log(`\n${failures === 0 ? '✅ COACH TOOLS — ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
