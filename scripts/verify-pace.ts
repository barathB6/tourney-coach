// Module 9 — pace estimator + kitchen notification verification.
//
// The estimate here decides when a chef starts plating food for 72 people, so
// the arithmetic gets tested against fixed clocks rather than eyeballed on a
// live round. The second half runs the real auto-fire against a disposable
// tournament to prove it fires once and only once.
//
//   npx tsx scripts/verify-pace.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  computeFieldPace, computeTeamPace, currentHoleFor, kitchenMessage,
  minutesPerHole, paceFromField, shouldNotifyKitchen,
  ASSUMED_MIN_PER_HOLE, KITCHEN_LEAD_MINUTES, type TeamPaceInput,
} from '../lib/pace';
import { toE164 } from '../lib/sms/twilio';
import { runKitchenCheck, loadFieldPace } from '../lib/pace/field';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

const TAG = 'ZZZ PACE';
const EMAIL_DOMAIN = 'pace.example.invalid';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

const NOW = new Date('2026-06-01T18:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

const team = (over: Partial<TeamPaceInput> & { registrationId: string }): TeamPaceInput => ({
  teamName: over.registrationId, startingHole: 1, holesCompleted: 0,
  firstSubmittedAt: null, lastSubmittedAt: null, ...over,
});

async function main() {
  // ── Pure maths ────────────────────────────────────────────────────────────
  section('1. Current hole (shotgun wraps around)');
  ok(currentHoleFor(1, 0) === 1, 'a group that has not started is on its starting hole');
  ok(currentHoleFor(1, 5) === 6, 'conventional start, thru 5 → hole 6');
  ok(currentHoleFor(17, 1) === 18, 'shotgun from 17, thru 1 → hole 18');
  ok(currentHoleFor(17, 2) === 1, 'shotgun from 17, thru 2 → wraps to hole 1');
  ok(currentHoleFor(17, 3) === 2, 'shotgun from 17, thru 3 → hole 2');
  ok(currentHoleFor(1, 18) === null, 'a finished group is on no hole');
  ok(currentHoleFor(null, 4) === 5, 'null starting hole is treated as the 1st tee');

  section('2. Minutes per hole (blended while the sample is thin)');
  ok(minutesPerHole(0, 60) === null, 'no holes posted → no pace');
  ok(minutesPerHole(6, 90) === 15, 'six holes in 90 min → 15 min/hole', String(minutesPerHole(6, 90)));
  // 1 hole in 4 min would imply a 72-minute round; blending keeps it sane.
  const thin = minutesPerHole(1, 4)!;
  ok(thin > 9 && thin < 11, 'a single fast hole is blended toward the assumption', `${thin.toFixed(1)} min/hole`);
  ok(minutesPerHole(3, 45) === 15, 'at three holes the measured pace is trusted outright');
  ok(Math.abs(minutesPerHole(1, ASSUMED_MIN_PER_HOLE)! - ASSUMED_MIN_PER_HOLE) < 0.001,
    'a hole exactly at the assumed pace blends to itself');

  section('3. Pace colour is field-relative');
  ok(paceFromField(0, 9) === null, 'a group that has not teed off has no colour');
  ok(paceFromField(9, 9) === 'green', 'level with the leader → green');
  ok(paceFromField(8, 9) === 'green', 'one back → still green');
  ok(paceFromField(7, 9) === 'yellow', 'two back → yellow');
  ok(paceFromField(6, 9) === 'yellow', 'three back → yellow');
  ok(paceFromField(5, 9) === 'red', 'four back → red, contact them');

  section('4. Finish estimate');
  const t1 = computeTeamPace(team({ registrationId: 'A', holesCompleted: 9, firstSubmittedAt: minsAgo(135), lastSubmittedAt: minsAgo(10) }), NOW, 9);
  ok(t1.status === 'playing', 'a group with holes left is playing');
  ok(Math.abs((t1.minutesPerHole ?? 0) - 15) < 0.01, '135 min over 9 holes → 15 min/hole', String(t1.minutesPerHole));
  ok(Math.abs((t1.minutesToFinish ?? 0) - 135) < 0.01, '9 holes left at 15 min → 135 min to finish', String(t1.minutesToFinish));
  ok(t1.estimatedFinish === new Date(NOW.getTime() + 135 * 60000).toISOString(), 'estimated finish is now + remaining');
  ok(t1.currentHole === 10, 'and they are on hole 10');

  const notStarted = computeTeamPace(team({ registrationId: 'B' }), NOW, 9);
  ok(notStarted.status === 'not_started' && notStarted.estimatedFinish === null,
    'a group with no scores gets no invented estimate');

  const done = computeTeamPace(team({ registrationId: 'C', holesCompleted: 18, firstSubmittedAt: minsAgo(260), lastSubmittedAt: minsAgo(5) }), NOW, 18);
  ok(done.status === 'finished' && done.minutesToFinish === 0, 'a finished group is finished');
  ok(done.estimatedFinish === minsAgo(5), 'their finish time is their last hole, not a projection');

  section('5. Field — the last group in is what the kitchen waits on');
  const field = computeFieldPace([
    team({ registrationId: 'fast', holesCompleted: 16, firstSubmittedAt: minsAgo(224), lastSubmittedAt: minsAgo(5) }),   // 14/hole → 28 left
    team({ registrationId: 'slow', holesCompleted: 12, firstSubmittedAt: minsAgo(216), lastSubmittedAt: minsAgo(12) }),  // 18/hole → 108 left
    team({ registrationId: 'done', holesCompleted: 18, firstSubmittedAt: minsAgo(250), lastSubmittedAt: minsAgo(2) }),
    team({ registrationId: 'idle' }),
  ], NOW);
  ok(field.playing === 2 && field.finished === 1 && field.notStarted === 1, 'field tallies', `${field.playing}/${field.finished}/${field.notStarted}`);
  ok(field.fieldMaxThru === 18, 'field max thru');
  ok(Math.abs((field.minutesUntilLastFinish ?? 0) - 108) < 0.5, 'last group in is driven by the SLOWEST group', String(field.minutesUntilLastFinish));
  ok(JSON.stringify(field.holesInPlay) === JSON.stringify([13, 17]), 'holes in play lists only groups still out', JSON.stringify(field.holesInPlay));
  ok(field.teams.find((t) => t.registrationId === 'slow')?.pace === 'red', 'the slow group is flagged red');

  section('6. Kitchen trigger');
  ok(!shouldNotifyKitchen(field), `not yet at ${KITCHEN_LEAD_MINUTES} min out`, `${Math.round(field.minutesUntilLastFinish!)} min`);
  const closing = computeFieldPace([
    team({ registrationId: 'last', holesCompleted: 16, firstSubmittedAt: minsAgo(320), lastSubmittedAt: minsAgo(6) }), // 20/hole → 40 left
  ], NOW);
  ok(shouldNotifyKitchen(closing), 'fires once the last group is inside 45 min', `${Math.round(closing.minutesUntilLastFinish!)} min`);
  const empty = computeFieldPace([team({ registrationId: 'done', holesCompleted: 18, firstSubmittedAt: minsAgo(250), lastSubmittedAt: minsAgo(2) })], NOW);
  ok(!shouldNotifyKitchen(empty), 'never fires when nobody is left on the course');

  const msg = kitchenMessage('St. Michael’s Cup', closing);
  console.log(`     "${msg}"`);
  ok(msg.startsWith('TourneyCoach: St. Michael’s Cup estimated finish in '), 'message matches the spec wording');
  ok(/Groups on holes 17\.$/.test(msg), 'message names the holes still in play', msg);

  section('7. Phone normalisation');
  ok(toE164('(985) 555-0134') === '+19855550134', 'formatted US number');
  ok(toE164('985-555-0134') === '+19855550134', 'dashed US number');
  ok(toE164('19855550134') === '+19855550134', 'with country code');
  ok(toE164('+447700900123') === '+447700900123', 'already E.164 passes through');
  ok(toE164('555-0134') === null, 'too short → refused rather than guessed');
  ok(toE164(null) === null, 'null → refused');

  // ── Live auto-fire ────────────────────────────────────────────────────────
  section('8. Auto-fire against a real tournament (idempotency)');
  const { data: user } = await db.auth.admin.createUser({
    email: `zzz-pace-${Date.now()}@${EMAIL_DOMAIN}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  if (!user?.user) throw new Error('could not create the test organizer');
  const organizerId = user.user.id;

  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE`, total_holes: 18, organizer_id: organizerId,
    contact_phone: '(985) 555-0134', profile_status: 'complete',
  }).select().single();
  const { data: tournament } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: organizerId, course_id: course!.id,
    event_date: '2026-06-01', format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'published',
  }).select().single();
  const tid = tournament!.id;

  const { data: reg } = await db.from('registrations').insert({
    tournament_id: tid, contact_name: 'Pace Team', contact_email: `team@${EMAIL_DOMAIN}`,
    registration_type: 'foursome', total_amount_cents: 60000, payment_status: 'paid',
    starting_hole: 1, players: [{ name: 'Pace Team', email: '' }],
  }).select('id').single();

  // 16 holes over 320 minutes → 20 min/hole → 2 holes left ≈ 40 min out.
  const rows = Array.from({ length: 16 }, (_, i) => ({
    registration_id: reg!.id, tournament_id: tid, course_id: course!.id,
    hole_number: i + 1, strokes: 4, green_labeled_points: 0,
    submitted_at: new Date(Date.now() - (320 - i * 20) * 60000).toISOString(),
  }));
  await db.from('score_submissions').insert(rows);

  const loaded = await loadFieldPace(db, tid);
  ok(loaded?.playing === 1, 'the live loader sees one group still out', `playing=${loaded?.playing}`);
  ok(loaded?.teams[0].holesCompleted === 16, 'holes completed read from real submissions', String(loaded?.teams[0].holesCompleted));
  ok(loaded?.kitchenPhone === '+19855550134', "the pro's number is picked up from the course profile", loaded?.kitchenPhone ?? 'null');
  ok((loaded?.minutesUntilLastFinish ?? 0) <= KITCHEN_LEAD_MINUTES, 'this fixture is inside the 45-minute window', `${Math.round(loaded?.minutesUntilLastFinish ?? 0)} min`);

  // A correction appends a row for an already-played hole; holes completed
  // must not double-count it.
  await db.from('score_submissions').insert({
    registration_id: reg!.id, tournament_id: tid, course_id: course!.id,
    hole_number: 3, strokes: 5, green_labeled_points: 0, submitted_at: new Date().toISOString(),
  });
  const afterCorrection = await loadFieldPace(db, tid);
  ok(afterCorrection?.teams[0].holesCompleted === 16, 'a corrected hole does not inflate progress', String(afterCorrection?.teams[0].holesCompleted));

  const first = await runKitchenCheck(db, tid);
  const smsOff = !process.env.TWILIO_ACCOUNT_SID && !get('TWILIO_ACCOUNT_SID');
  if (smsOff) {
    ok(!first.fired && /not configured|SMS/i.test(first.reason), 'without Twilio configured it reports honestly instead of pretending', first.reason);
    ok(!!first.message && first.message.includes('estimated finish in'), 'and it still composed the correct message', first.message);
    const { data: failedRow } = await db.from('kitchen_notifications').select('status, error').eq('tournament_id', tid).maybeSingle();
    ok(failedRow?.status === 'failed', 'the attempt is recorded as failed, not silently dropped', failedRow?.status ?? 'no row');
    const retry = await runKitchenCheck(db, tid);
    ok(!retry.fired, 'a failed attempt can be retried rather than blocking forever', retry.reason);
  } else {
    ok(first.fired, 'kitchen notified', first.reason);
    const second = await runKitchenCheck(db, tid);
    ok(!second.fired && second.reason === 'already notified', 'a second check does NOT text the chef again', second.reason);
    const { count } = await db.from('kitchen_notifications').select('id', { count: 'exact', head: true }).eq('tournament_id', tid).eq('status', 'sent');
    ok(count === 1, 'exactly one notification row exists', `${count}`);
  }

  // Not-yet-due tournaments must stay quiet.
  const { data: earlyReg } = await db.from('registrations').insert({
    tournament_id: tid, contact_name: 'Early Team', contact_email: `early@${EMAIL_DOMAIN}`,
    registration_type: 'foursome', total_amount_cents: 60000, payment_status: 'paid',
    starting_hole: 10, players: [{ name: 'Early Team', email: '' }],
  }).select('id').single();
  await db.from('score_submissions').insert(Array.from({ length: 2 }, (_, i) => ({
    registration_id: earlyReg!.id, tournament_id: tid, course_id: course!.id,
    hole_number: 10 + i, strokes: 4, green_labeled_points: 0,
    submitted_at: new Date(Date.now() - (30 - i * 15) * 60000).toISOString(),
  })));
  const withEarly = await loadFieldPace(db, tid);
  ok((withEarly?.minutesUntilLastFinish ?? 0) > KITCHEN_LEAD_MINUTES,
    'a group only 2 holes in pushes the last-finish estimate back out', `${Math.round(withEarly?.minutesUntilLastFinish ?? 0)} min`);
  ok(withEarly?.teams.find((t) => t.teamName === 'Early Team')?.currentHole === 12,
    'their shotgun start is respected (from 10, thru 2 → hole 12)');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('9. Cleanup');
  const { data: tagged } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  for (const t of tagged ?? []) {
    await db.from('kitchen_notifications').delete().eq('tournament_id', t.id);
    await db.from('score_submissions').delete().eq('tournament_id', t.id);
    await db.from('registrations').delete().eq('tournament_id', t.id);
    await db.from('tournaments').delete().eq('id', t.id);
  }
  const { data: courses } = await db.from('courses').select('id').ilike('name', `${TAG}%`);
  for (const c of courses ?? []) await db.from('courses').delete().eq('id', c.id);
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) if (u.email?.endsWith(EMAIL_DOMAIN)) await db.auth.admin.deleteUser(u.id);
  const { data: left } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  ok((left?.length ?? 0) === 0, 'fixtures removed', `${left?.length ?? 0} left`);

  console.log(`\n${failures === 0 ? '✅ PACE + KITCHEN — ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
