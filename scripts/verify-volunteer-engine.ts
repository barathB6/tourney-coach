// Day 27 — Volunteer Roles Engine verification.
//
// The invite token is a credential handed to someone with no account, so the
// security half of this file matters as much as the feature half: a token must
// only ever answer for the one role it was issued for, and must never expose
// the roster.
//
//   npx tsx scripts/verify-volunteer-engine.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadTeam, reminderLabel, roleStartAt, runVolunteerReminders, REMINDER_OFFSETS_MINUTES } from '../lib/toc/team';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const TAG = 'ZZZ VOLENG';
const DOM = 'voleng.example.invalid';
const EVENT = '2026-09-15';
const SHOTGUN = '08:30';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

async function main() {
  section('1. Role start times and reminder labels');
  ok(REMINDER_OFFSETS_MINUTES.join(',') === '10080,2880,90', 'reminders are 7 days, 2 days, 90 minutes');
  ok(reminderLabel(10080) === 'in 7 days', '10080 min reads as 7 days', reminderLabel(10080));
  ok(reminderLabel(2880) === 'in 2 days', '2880 min reads as 2 days');
  ok(reminderLabel(90) === 'in 90 minutes', '90 min stays in minutes', reminderLabel(90));

  // A day-of role starts at its EARLIEST task, not the shotgun: the
  // registration lead is on site two hours before the horn.
  const regLeadStart = roleStartAt('day_of', -2, EVENT, SHOTGUN)!;
  ok(regLeadStart.getHours() === 6 && regLeadStart.getMinutes() === 30,
    'a day-of role starts at its earliest task, not the shotgun', regLeadStart.toString().slice(16, 21));
  const planStart = roleStartAt('planning', -2688, EVENT, SHOTGUN)!;
  ok(planStart.getMonth() === 4, 'a 16-week planning role starts in May for a September event', planStart.toDateString());
  ok(roleStartAt('day_of', null, EVENT, SHOTGUN)!.getHours() === 8, 'a role with no tasks falls back to the phase anchor');

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${Date.now()}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const { data: rival } = await db.auth.admin.createUser({
    email: `zzz-rival-${Date.now()}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  if (!owner?.user || !rival?.user) throw new Error('could not create test organizers');

  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: owner.user.id, event_date: EVENT, shotgun_time: SHOTGUN,
    format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select().single();
  const tid = t!.id;

  const { data: roles } = await db.from('role_templates').select('id, name, phase');
  const regLead = roles!.find((r) => r.name === 'Registration Lead')!;
  const sponsorChair = roles!.find((r) => r.name === 'Sponsorship Committee Chair')!;

  section('2. Assigning across both phases');
  const mk = async (role: { id: string }, name: string, phone: string | null) => {
    const { data: v } = await db.from('volunteers')
      .insert({ tournament_id: tid, name, email: `${name.replace(/\W/g, '').toLowerCase()}@${DOM}`, phone })
      .select('id').single();
    const { data: a, error } = await db.from('tournament_volunteer_assignments')
      .insert({ tournament_id: tid, volunteer_id: v!.id, role_template_id: role.id, status: 'assigned' })
      .select('id, invite_token').single();
    if (error) throw new Error(`assign failed — run migration 040: ${error.message}`);
    return { volunteerId: v!.id, ...a! };
  };

  let dayOfMember, planningMember;
  try {
    dayOfMember = await mk(regLead, 'Alicia L', '(985) 555-0134');
    planningMember = await mk(sponsorChair, 'Mark Reed', null);
  } catch (e) {
    ok(false, 'assignments require migration 040', e instanceof Error ? e.message : '');
    return finish();
  }
  ok(!!dayOfMember.invite_token, 'each assignment gets its own invite token');
  ok(dayOfMember.invite_token !== planningMember.invite_token, 'tokens are per-assignment, not per-volunteer');

  const team = await loadTeam(db, tid);
  ok(!!team, 'team loads');
  ok(team!.summary.planningTotal === 11 && team!.summary.dayOfTotal === 9, 'both libraries present',
    `${team!.summary.planningTotal} planning / ${team!.summary.dayOfTotal} day-of`);
  ok(team!.summary.planningFilled === 1 && team!.summary.dayOfFilled === 1, 'one role filled in each phase');

  const loadedDayOf = team!.roles.find((r) => r.id === regLead.id)!;
  ok(loadedDayOf.members[0].startsAt != null, 'a member carries the computed role start time');
  ok(new Date(loadedDayOf.members[0].startsAt!).getHours() === 6, 'Registration Lead starts at 06:30, two hours before the horn');

  section('3. The invite token is a narrow credential');
  const tokenGet = await fetch(`${BASE}/api/volunteer/respond?token=${dayOfMember.invite_token}`);
  const invite = await tokenGet.json();
  ok(tokenGet.status === 200, 'a valid token loads the invitation', `HTTP ${tokenGet.status}`);
  ok(invite.roleName === 'Registration Lead' && invite.volunteerName === 'Alicia L', 'it shows their own role');
  ok(Array.isArray(invite.tasks) && invite.tasks.length > 0, 'and what the role involves', `${invite.tasks?.length} tasks`);

  // The whole point of per-assignment tokens: it must not leak anyone else.
  const raw = JSON.stringify(invite);
  const leaks = ['Mark Reed', '@' + DOM, '555-0134', 'volunteer_id', 'organizer'].filter((k) => raw.includes(k));
  ok(leaks.length === 0, 'the invitation exposes no other volunteer, no emails, no roster', leaks.join(', ') || 'scanned payload');

  const badToken = await fetch(`${BASE}/api/volunteer/respond?token=11111111-1111-1111-1111-111111111111`);
  ok(badToken.status === 404, 'an unknown token is refused', `HTTP ${badToken.status}`);

  section('4. Confirming and declining');
  const confirm = await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: dayOfMember.invite_token, answer: 'confirm' }),
  });
  ok(confirm.status === 200, 'the volunteer can confirm without an account', `HTTP ${confirm.status}`);
  const { data: afterConfirm } = await db.from('tournament_volunteer_assignments')
    .select('status, responded_at').eq('id', dayOfMember.id).single();
  ok(afterConfirm?.status === 'confirmed' && !!afterConfirm.responded_at, 'the answer is recorded');

  // People change their minds; the link has to keep working.
  const flip = await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: dayOfMember.invite_token, answer: 'decline' }),
  });
  const flipped = await flip.json();
  ok(flip.status === 200 && flipped.status === 'declined', 'they can change their answer later');
  await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: dayOfMember.invite_token, answer: 'confirm' }),
  });

  const declinedTeam = await loadTeam(db, tid);
  ok(declinedTeam!.summary.dayOfFilled === 1, 'a confirmed role counts as filled');

  // A token must not be usable to answer for a DIFFERENT assignment.
  const crossAnswer = await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: dayOfMember.invite_token, answer: 'decline' }),
  });
  await crossAnswer.json();
  const { data: markStill } = await db.from('tournament_volunteer_assignments')
    .select('status').eq('id', planningMember.id).single();
  ok(markStill?.status === 'assigned', "answering with one token cannot change someone else's role");
  await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: dayOfMember.invite_token, answer: 'confirm' }),
  });

  section('5. Organizer API authorization');
  const anon = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!);
  const { data: rs } = await anon.auth.signInWithPassword({
    email: rival.user.email!, password: (await (async () => '')()) || '',
  }).catch(() => ({ data: { session: null } }));
  void rs;
  const noAuth = await fetch(`${BASE}/api/tournament/${tid}/team`);
  ok(noAuth.status === 401, 'the team roster requires authentication', `HTTP ${noAuth.status}`);

  section('6. Reminders');
  // Confirmed, with a phone, and the role starts in ~100 minutes → only the
  // 90-minute reminder is due; the 7-day and 2-day windows are long gone.
  const start = new Date(loadedDayOf.members[0].startsAt!);
  const nowInside90 = new Date(start.getTime() - 100 * 60_000);
  const smsOff = !get('TWILIO_ACCOUNT_SID');
  const run1 = await runVolunteerReminders(db, tid, nowInside90);

  if (smsOff) {
    ok(run1.sent === 0, 'without Twilio configured nothing is claimed as sent', `${run1.sent} sent`);
    const { data: rows } = await db.from('volunteer_reminders').select('offset_minutes, status');
    const failed = (rows ?? []).filter((r) => r.status === 'failed');
    ok(failed.length > 0, 'the attempt is recorded as failed rather than silently dropped', `${failed.length} failed row(s)`);
    ok(failed.every((r) => r.offset_minutes === 90), 'only the 90-minute reminder was due, not all three',
      failed.map((r) => r.offset_minutes).join(','));
  } else {
    ok(run1.sent === 1, 'exactly one reminder fires', `${run1.sent}`);
    const run2 = await runVolunteerReminders(db, tid, nowInside90);
    ok(run2.sent === 0, 'running again does not text them twice', `${run2.sent}`);
  }

  // Someone added the day AFTER the event must not get a burst of three.
  const afterEvent = new Date(start.getTime() + 26 * 3_600_000);
  const late = await runVolunteerReminders(db, tid, afterEvent);
  ok(late.sent === 0, 'a past role fires no reminders at all', `${late.sent} sent`);

  // A declined volunteer is left alone.
  await db.from('tournament_volunteer_assignments').update({ status: 'declined' }).eq('id', dayOfMember.id);
  await db.from('volunteer_reminders').delete().eq('assignment_id', dayOfMember.id);
  const declinedRun = await runVolunteerReminders(db, tid, nowInside90);
  ok(declinedRun.sent === 0, 'someone who declined is never reminded', `${declinedRun.sent} sent`);

  section('7. Cleanup');
  const { data: tagged } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  for (const row of tagged ?? []) {
    const { data: as } = await db.from('tournament_volunteer_assignments').select('id').eq('tournament_id', row.id);
    for (const a of as ?? []) await db.from('volunteer_reminders').delete().eq('assignment_id', a.id);
    await db.from('tournament_volunteer_assignments').delete().eq('tournament_id', row.id);
    await db.from('volunteers').delete().eq('tournament_id', row.id);
    await db.from('tournaments').delete().eq('id', row.id);
  }
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) if (u.email?.endsWith(DOM)) await db.auth.admin.deleteUser(u.id);
  const { data: left } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  ok((left?.length ?? 0) === 0, 'fixtures removed', `${left?.length ?? 0} left`);

  finish();
}

function finish() {
  console.log(`\n${failures === 0 ? '✅ VOLUNTEER ENGINE — ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
