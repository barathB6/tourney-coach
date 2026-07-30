// Day 26 — Tournament Operations Center foundation verification.
//
// Two halves: the phase engine's arithmetic against fixed clocks, and the
// seeded role libraries + derived goals against a disposable tournament.
//
//   npx tsx scripts/verify-toc.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  anchorFor, buildGoals, describeOffset, dueAt, HOURS_PER_WEEK, isPhase, taskStatus,
} from '../lib/toc/phase';
import { loadOperationsCenter } from '../lib/toc/load';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

const TAG = 'ZZZ TOC';
const EMAIL_DOMAIN = 'toc.example.invalid';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

const EVENT = '2026-09-15';
const SHOTGUN = '08:30';

async function main() {
  // ── Phase engine ──────────────────────────────────────────────────────────
  section('1. Anchors — the two clocks');
  ok(isPhase('planning') && isPhase('day_of') && !isPhase('nope'), 'phase guard accepts only the two phases');
  const pAnchor = anchorFor('planning', EVENT, SHOTGUN)!;
  const dAnchor = anchorFor('day_of', EVENT, SHOTGUN)!;
  ok(pAnchor.getHours() === 0, 'planning anchors to the start of event day', pAnchor.toString().slice(0, 21));
  ok(dAnchor.getHours() === 8 && dAnchor.getMinutes() === 30, 'day-of anchors to the shotgun time', dAnchor.toString().slice(0, 21));
  ok(anchorFor('day_of', EVENT, null)!.getHours() === 8, 'a missing shotgun time falls back to 08:00 rather than nothing');
  ok(anchorFor('planning', null, null) === null, 'no event date → no anchor, rather than a guess');

  // The distinction that matters: moving the shotgun must NOT move planning work.
  const planningDue = dueAt('planning', -2688, EVENT, SHOTGUN)!;
  const planningDueLater = dueAt('planning', -2688, EVENT, '11:00')!;
  ok(planningDue.getTime() === planningDueLater.getTime(),
    'changing the shotgun time does not move a planning task', '16 weeks out is still 16 weeks out');
  const dayOfDue = dueAt('day_of', -2, EVENT, SHOTGUN)!;
  const dayOfDueLater = dueAt('day_of', -2, EVENT, '11:00')!;
  ok(dayOfDue.getTime() !== dayOfDueLater.getTime(), 'but it DOES move a day-of task', 'the horn is the anchor');
  ok(dayOfDue.getHours() === 6 && dayOfDue.getMinutes() === 30, '2h before an 08:30 shotgun = 06:30', dayOfDue.toString().slice(16, 21));

  section('2. Offsets read the way a human plans');
  ok(describeOffset('planning', -2688) === '16 weeks before', '-2688h → 16 weeks before', describeOffset('planning', -2688));
  ok(describeOffset('planning', -HOURS_PER_WEEK) === '1 week before', 'singular week, not "1 weeks"');
  ok(describeOffset('planning', -72) === '3 days before', 'sub-week planning falls back to days', describeOffset('planning', -72));
  ok(describeOffset('day_of', -2) === '2h before the shotgun', 'day-of speaks in hours', describeOffset('day_of', -2));
  ok(describeOffset('day_of', 0) === 'at the shotgun', 'zero is the horn itself');
  ok(describeOffset('planning', null) === 'no due date', 'a task with no offset says so');

  section('3. Day-of tasks stay quiet until the day');
  const weeksEarly = new Date('2026-07-01T12:00:00');
  const eventMorning = new Date(`${EVENT}T07:00:00`);
  ok(taskStatus('day_of', dueAt('day_of', -2, EVENT, SHOTGUN), weeksEarly, EVENT) === 'not_applicable',
    '"set up the check-in table" is not overdue eleven weeks early');
  ok(taskStatus('day_of', dueAt('day_of', -2, EVENT, SHOTGUN), eventMorning, EVENT) === 'overdue',
    'but on the morning, 06:30 has passed by 07:00 → overdue');
  ok(taskStatus('day_of', dueAt('day_of', 4, EVENT, SHOTGUN), eventMorning, EVENT) === 'upcoming',
    'and the awards ceremony is still upcoming');
  // -168h from Sep 15 is Sep 8, still ~10 weeks after this "now".
  ok(taskStatus('planning', dueAt('planning', -168, EVENT, SHOTGUN), weeksEarly) === 'upcoming',
    'a planning task still ahead of today is upcoming');
  // 16 weeks before Sep 15 is late May — already past a July "now".
  ok(taskStatus('planning', dueAt('planning', -2688, EVENT, SHOTGUN), weeksEarly) === 'overdue',
    'a 16-week-out task is overdue by July', 'the deadline was in May');
  const juneFirst = new Date('2026-06-01T12:00:00');
  ok(taskStatus('planning', dueAt('planning', -2688, EVENT, SHOTGUN), juneFirst) === 'overdue',
    'and still overdue on June 1');
  ok(taskStatus('planning', dueAt('planning', -2688, EVENT, SHOTGUN), new Date('2026-05-20T12:00:00')) === 'due_soon',
    'six days ahead of it, it reads as due soon');
  ok(taskStatus('planning', dueAt('planning', -24, EVENT, SHOTGUN), new Date(`${EVENT}T00:00:00`)) === 'overdue',
    'a planning task whose date has passed is overdue');

  section('4. Goal maths');
  const goals = buildGoals(
    { player_goal: 72, sponsorship_goal_cents: 2_000_000, donation_items_goal: 0, marketing_reach_goal: 500, volunteer_roles_goal: 9 },
    { players: 36, sponsorshipCents: 2_500_000, donationItems: 0, marketingReach: 125, rolesFilled: 9 },
  );
  const byKey = Object.fromEntries(goals.map((g) => [g.key, g]));
  ok(byKey.players.percent === 50 && !byKey.players.met, 'half the field → 50%, not met');
  ok(byKey.sponsorship.percent === 100 && byKey.sponsorship.met, 'over target caps at 100% and reads as met');
  ok(byKey.donations.percent === 100 && byKey.donations.met, 'a target of zero is met, not a divide-by-zero', 'chasing no auction items is a real answer');
  ok(byKey.volunteers.met, 'every role filled → met');
  const unset = buildGoals(null, { players: 10, sponsorshipCents: 0, donationItems: 0, marketingReach: 0, rolesFilled: 0 });
  ok(unset.every((g) => g.percent === null && !g.met), 'no goals set → null percent, never a fake 0%');
  ok(unset[0].actual === 10, 'actuals still report even with no target');

  // ── Live data ─────────────────────────────────────────────────────────────
  section('5. Seeded role libraries');
  const { data: roles, error: roleErr } = await db.from('role_templates').select('id, name, phase, sort_order');
  if (roleErr) {
    ok(false, 'role_templates readable', roleErr.message);
    console.log('\n  Migration 039 has not been applied — skipping the live half.');
    return finish();
  }
  const planning = (roles ?? []).filter((r) => r.phase === 'planning');
  const dayOf = (roles ?? []).filter((r) => r.phase === 'day_of');
  ok(planning.length === 11, 'eleven planning roles seeded', `${planning.length}`);
  ok(dayOf.length === 9, 'nine day-of roles seeded', `${dayOf.length}`);

  const expectPlanning = ['Sponsorship Committee Chair', 'Donation Outreach Lead', 'Marketing Coordinator',
    'Player Recruitment Captain', 'Communications Lead', 'Course Liaison', 'Logistics Lead',
    'Volunteer Coordinator', 'Cause Story Lead', 'Auction Item Hunter', 'Goal Tracker'];
  const missingPlanning = expectPlanning.filter((n) => !planning.some((r) => r.name === n));
  ok(missingPlanning.length === 0, 'every planning role from the spec is present', missingPlanning.join(', ') || 'all 11');

  const expectDayOf = ['Registration Lead', 'Registration Volunteer', 'Beverage Cart Driver',
    'Contest Hole Monitor', 'Scoring Runner', 'Kitchen Liaison', 'Awards Setup Crew',
    'Photographer', 'Takedown Crew'];
  const missingDayOf = expectDayOf.filter((n) => !dayOf.some((r) => r.name === n));
  ok(missingDayOf.length === 0, 'every day-of role from the spec is present', missingDayOf.join(', ') || 'all 9');

  const { data: tasks } = await db.from('task_templates').select('role_template_id, phase, due_offset_hours');
  const roleIdsWithTasks = new Set((tasks ?? []).map((t) => t.role_template_id));
  const barren = (roles ?? []).filter((r) => !roleIdsWithTasks.has(r.id));
  ok(barren.length === 0, 'every role carries at least one task', barren.map((r) => r.name).join(', ') || `${tasks?.length} tasks total`);

  const planningTasks = (tasks ?? []).filter((t) => t.phase === 'planning');
  const dayOfTasks = (tasks ?? []).filter((t) => t.phase === 'day_of');
  ok(planningTasks.every((t) => Math.abs(t.due_offset_hours ?? 0) >= 24),
    'planning offsets are all at least a day out — none accidentally in hours');
  ok(dayOfTasks.every((t) => Math.abs(t.due_offset_hours ?? 0) <= 12),
    'day-of offsets all sit within a tournament day', `max ${Math.max(...dayOfTasks.map((t) => Math.abs(t.due_offset_hours ?? 0)))}h`);

  section('6. Operations Center against a real tournament');
  const { data: user } = await db.auth.admin.createUser({
    email: `zzz-toc-${Date.now()}@${EMAIL_DOMAIN}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  if (!user?.user) throw new Error('could not create the test organizer');
  const organizerId = user.user.id;

  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: organizerId, event_date: EVENT, shotgun_time: SHOTGUN,
    format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select().single();
  const tid = t!.id;

  // Two foursomes + a single = 9 players. The refunded one must not count.
  await db.from('registrations').insert([
    { tournament_id: tid, contact_name: 'A', contact_email: `a@${EMAIL_DOMAIN}`, registration_type: 'foursome', total_amount_cents: 60000, payment_status: 'paid', players: [] },
    { tournament_id: tid, contact_name: 'B', contact_email: `b@${EMAIL_DOMAIN}`, registration_type: 'foursome', total_amount_cents: 60000, payment_status: 'paid', players: [] },
    { tournament_id: tid, contact_name: 'C', contact_email: `c@${EMAIL_DOMAIN}`, registration_type: 'single', total_amount_cents: 16500, payment_status: 'paid', players: [] },
    { tournament_id: tid, contact_name: 'D', contact_email: `d@${EMAIL_DOMAIN}`, registration_type: 'foursome', total_amount_cents: 60000, payment_status: 'refunded', players: [] },
    { tournament_id: tid, contact_name: 'E', contact_email: `e@${EMAIL_DOMAIN}`, registration_type: 'sponsor', total_amount_cents: 500000, payment_status: 'paid', players: [] },
  ]);
  await db.from('sponsors').insert([
    { tournament_id: tid, company: 'Committed Co', status: 'paid', amount_cents: 500000 },
    { tournament_id: tid, company: 'Verbal Co', status: 'verbal', amount_cents: 250000 },
    { tournament_id: tid, company: 'Cold Co', status: 'not_contacted', amount_cents: 999999 },
  ]);
  await db.from('donation_prospects').insert([
    { tournament_id: tid, name: 'Item One' }, { tournament_id: tid, name: 'Item Two' },
  ]);

  const { data: vol } = await db.from('volunteers').insert({
    tournament_id: tid, name: 'Dana Marshal', email: `dana@${EMAIL_DOMAIN}`, role: 'Registration Lead',
  }).select('id').single();
  const regLead = dayOf.find((r) => r.name === 'Registration Lead')!;
  await db.from('tournament_volunteer_assignments').insert({
    tournament_id: tid, volunteer_id: vol!.id, role_template_id: regLead.id, status: 'confirmed',
  });

  await db.from('tournament_goals').insert({
    tournament_id: tid, player_goal: 72, sponsorship_goal_cents: 2_000_000,
    donation_items_goal: 10, marketing_reach_goal: 500, volunteer_roles_goal: 9,
  });

  const snap = await loadOperationsCenter(db, tid, new Date('2026-07-01T12:00:00'));
  ok(!!snap, 'operations center loads');
  if (!snap) return finish();

  ok(snap.counts.planningRoles === 11 && snap.counts.dayOfRoles === 9, 'both libraries present in the snapshot',
    `${snap.counts.planningRoles} planning / ${snap.counts.dayOfRoles} day-of`);

  const g = Object.fromEntries(snap.goals.map((x) => [x.key, x]));
  ok(g.players.actual === 9, 'players counts 4+4+1 and ignores the refund and the sponsor package', `${g.players.actual}`);
  ok(g.sponsorship.actual === 750000, 'sponsorship counts paid + verbal, not cold prospects', `$${g.sponsorship.actual / 100}`);
  ok(g.donations.actual === 2, 'donation items counted', `${g.donations.actual}`);
  ok(g.volunteers.actual === 1 && !g.volunteers.met, 'one of nine roles filled', `${g.volunteers.actual}/9`);

  const filled = snap.roles.find((r) => r.id === regLead.id);
  ok(filled?.assigned.length === 1 && filled.assigned[0].name === 'Dana Marshal', 'the assignment resolves to a named volunteer');

  // Progress is derived — refunding a team must move the number with no writes.
  await db.from('registrations').update({ payment_status: 'refunded' }).eq('tournament_id', tid).eq('contact_name', 'A');
  const after = await loadOperationsCenter(db, tid, new Date('2026-07-01T12:00:00'));
  ok(after!.goals.find((x) => x.key === 'players')!.actual === 5,
    'refunding a foursome drops the player count with no goal write', `${after!.goals.find((x) => x.key === 'players')!.actual}`);

  // Assignment uniqueness.
  const { error: dupErr } = await db.from('tournament_volunteer_assignments').insert({
    tournament_id: tid, volunteer_id: vol!.id, role_template_id: regLead.id, status: 'assigned',
  });
  ok(dupErr?.code === '23505', 'the same volunteer cannot hold the same role twice', dupErr?.code ?? 'insert succeeded');

  // Day-of tasks must be quiet in July but live on event day.
  const julyDayOf = snap.roles.filter((r) => r.phase === 'day_of').flatMap((r) => r.tasks);
  ok(julyDayOf.every((t) => t.status === 'not_applicable'), 'in July, no day-of task nags');
  const onTheDay = await loadOperationsCenter(db, tid, new Date(`${EVENT}T07:00:00`));
  const dayTasks = onTheDay!.roles.filter((r) => r.phase === 'day_of').flatMap((r) => r.tasks);
  ok(dayTasks.some((t) => t.status !== 'not_applicable'), 'on event morning they wake up',
    `${dayTasks.filter((t) => t.status !== 'not_applicable').length} live`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('7. Cleanup');
  const { data: tagged } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  for (const row of tagged ?? []) {
    await db.from('tournament_volunteer_assignments').delete().eq('tournament_id', row.id);
    await db.from('tournament_goals').delete().eq('tournament_id', row.id);
    await db.from('donation_prospects').delete().eq('tournament_id', row.id);
    await db.from('volunteers').delete().eq('tournament_id', row.id);
    await db.from('sponsors').delete().eq('tournament_id', row.id);
    await db.from('registrations').delete().eq('tournament_id', row.id);
    await db.from('tournaments').delete().eq('id', row.id);
  }
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) if (u.email?.endsWith(EMAIL_DOMAIN)) await db.auth.admin.deleteUser(u.id);
  const { data: left } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  ok((left?.length ?? 0) === 0, 'fixtures removed', `${left?.length ?? 0} left`);

  finish();
}

function finish() {
  console.log(`\n${failures === 0 ? '✅ TOC FOUNDATION — ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
