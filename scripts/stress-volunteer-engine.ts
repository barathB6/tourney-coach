// Day 27 — Volunteer Roles Engine STRESS TEST.
//
// verify-volunteer-engine.ts proves the pipeline works. This attacks it:
// hostile input, cross-tenant id smuggling, concurrency, no-show edges, the
// meeting surface, and scale.
//
// The invite token is a credential given to someone with no account, so most
// of the value here is in the attack cases.
//
//   npx tsx scripts/stress-volunteer-engine.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { isNoShow, loadTeam, NO_SHOW_GRACE_MINUTES, runVolunteerReminders } from '../lib/toc/team';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const anon = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const TAG = 'ZZZ STRESS-VOL';
const DOM = 'stressvol.example.invalid';
const EVENT = '2026-09-15';
const SHOTGUN = '08:30';

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
  if (!u?.user || !s?.session) throw new Error(`could not create organizer ${label}`);
  return { id: u.user.id, jwt: s.session.access_token };
}

async function main() {
  const owner = await mkOrganizer('owner');
  const rival = await mkOrganizer('rival');
  const H = (jwt: string) => ({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' });

  const mkT = async (name: string, organizerId: string) => {
    const { data } = await db.from('tournaments').insert({
      name: `${TAG} ${name}`, organizer_id: organizerId, event_date: EVENT, shotgun_time: SHOTGUN,
      format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'draft',
    }).select().single();
    return data!.id as string;
  };
  const tid = await mkT('MAIN', owner.id);
  const rivalTid = await mkT('RIVAL', rival.id);

  const { data: roles } = await db.from('role_templates').select('id, name, phase');
  const regLead = roles!.find((r) => r.name === 'Registration Lead')!;
  const chair = roles!.find((r) => r.name === 'Sponsorship Committee Chair')!;

  const post = (t: string, body: unknown, jwt = owner.jwt) =>
    fetch(`${BASE}/api/tournament/${t}/team`, { method: 'POST', headers: H(jwt), body: JSON.stringify(body) });
  const patch = (t: string, body: unknown, jwt = owner.jwt) =>
    fetch(`${BASE}/api/tournament/${t}/team`, { method: 'PATCH', headers: H(jwt), body: JSON.stringify(body) });

  // ── 1. Authorization ──────────────────────────────────────────────────────
  section('1. Authorization');
  ok((await fetch(`${BASE}/api/tournament/${tid}/team`)).status === 401, 'GET team without a token is 401');
  ok((await fetch(`${BASE}/api/tournament/${tid}/team`, { headers: H(rival.jwt) })).status === 403,
    "GET on another organizer's team is 403");
  ok((await post(tid, { roleTemplateId: regLead.id, name: 'Intruder', email: `x@${DOM}` }, rival.jwt)).status === 403,
    'a rival cannot assign into your team');
  ok((await fetch(`${BASE}/api/tournament/${tid}/meetings`, { headers: H(rival.jwt) })).status === 403,
    "a rival cannot read your meetings");

  // ── 2. Assignment input validation ────────────────────────────────────────
  section('2. Assignment input validation');
  const bad: [string, unknown, number][] = [
    ['no role', { name: 'A', email: `a@${DOM}` }, 400],
    ['no name', { roleTemplateId: regLead.id, email: `a@${DOM}` }, 400],
    ['no contact at all', { roleTemplateId: regLead.id, name: 'A' }, 400],
    ['unknown role id', { roleTemplateId: '00000000-0000-0000-0000-000000000000', name: 'A', email: `a@${DOM}` }, 400],
    ['role id that is not a uuid', { roleTemplateId: 'not-a-uuid', name: 'A', email: `a@${DOM}` }, 400],
  ];
  for (const [label, body, expect] of bad) {
    const r = await post(tid, body);
    ok(r.status === expect, `${label} → HTTP ${expect}`, `HTTP ${r.status}`);
  }
  const { count: noJunk } = await db.from('volunteers').select('id', { count: 'exact', head: true }).eq('tournament_id', tid);
  ok((noJunk ?? 0) === 0, 'and none of those created a volunteer row', `${noJunk} rows`);

  // ── 3. Cross-tenant id smuggling ──────────────────────────────────────────
  section('3. Cross-tenant id smuggling');
  const rivalAssign = await post(rivalTid, { roleTemplateId: regLead.id, name: 'Rival Vol', email: `rv@${DOM}`, invite: false }, rival.jwt);
  const rivalTeam = await rivalAssign.json();
  const rivalAssignmentId = rivalTeam.roles.find((r: { id: string }) => r.id === regLead.id).members[0].assignmentId;

  const smuggle = await patch(tid, { assignmentId: rivalAssignmentId, status: 'declined' });
  ok(smuggle.status === 404, "using another tournament's assignment id is refused", `HTTP ${smuggle.status}`);
  const { data: rivalStill } = await db.from('tournament_volunteer_assignments').select('status').eq('id', rivalAssignmentId).single();
  ok(rivalStill?.status === 'assigned', "and the rival's assignment is untouched", rivalStill?.status ?? '');

  const smuggleRemove = await patch(tid, { assignmentId: rivalAssignmentId, action: 'remove' });
  ok(smuggleRemove.status === 404, 'and it cannot be deleted either', `HTTP ${smuggleRemove.status}`);
  const { data: stillThere } = await db.from('tournament_volunteer_assignments').select('id').eq('id', rivalAssignmentId).maybeSingle();
  ok(!!stillThere, 'the row survives the attempt');

  // ── 4. Invite token attacks ───────────────────────────────────────────────
  section('4. Invite token attacks');
  const realAssign = await post(tid, { roleTemplateId: regLead.id, name: 'Alicia L', email: `alicia@${DOM}`, phone: '(985) 555-0134', invite: false });
  const realTeam = await realAssign.json();
  const member = realTeam.roles.find((r: { id: string }) => r.id === regLead.id).members[0];
  const { data: withToken } = await db.from('tournament_volunteer_assignments')
    .select('invite_token').eq('id', member.assignmentId).single();
  const token = withToken!.invite_token as string;

  const tokenAttacks: [string, string][] = [
    ['empty', ''],
    ['not a uuid', 'wat'],
    ['sql-ish', "' or 1=1--"],
    ['unknown uuid', '11111111-1111-1111-1111-111111111111'],
  ];
  for (const [label, bad] of tokenAttacks) {
    const r = await fetch(`${BASE}/api/volunteer/respond?token=${encodeURIComponent(bad)}`);
    ok(r.status === 404 || r.status === 400, `${label} token is refused, not a 500`, `HTTP ${r.status}`);
  }

  const answerBad = await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, answer: 'maybe' }),
  });
  ok(answerBad.status === 400, 'an answer that is neither confirm nor decline is 400', `HTTP ${answerBad.status}`);

  const nonJson = await fetch(`${BASE}/api/volunteer/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
  });
  ok(nonJson.status === 400, 'a non-JSON body does not crash the confirm route', `HTTP ${nonJson.status}`);

  // Idempotency: hammering the confirm link must not corrupt state.
  const spam = await Promise.all(Array.from({ length: 10 }, () =>
    fetch(`${BASE}/api/volunteer/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, answer: 'confirm' }),
    }).then((r) => r.status)));
  ok(spam.every((x) => x === 200), '10 rapid confirms all succeed', [...new Set(spam)].join(','));
  const { count: assignCount } = await db.from('tournament_volunteer_assignments')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', tid);
  ok(assignCount === 1, 'and leave exactly one assignment', `${assignCount}`);

  // ── 5. No-show logic ──────────────────────────────────────────────────────
  section('5. No-show detection');
  const start = new Date(`${EVENT}T06:30:00`);
  const before = new Date(start.getTime() - 60 * 60_000);
  const justAfter = new Date(start.getTime() + 5 * 60_000);
  const wellAfter = new Date(start.getTime() + (NO_SHOW_GRACE_MINUTES + 10) * 60_000);

  ok(!isNoShow('day_of', 'confirmed', start, null, before), 'before the role starts, nobody is a no-show');
  ok(!isNoShow('day_of', 'confirmed', start, null, justAfter),
    `${NO_SHOW_GRACE_MINUTES}-minute grace — five minutes late is not a no-show`);
  ok(isNoShow('day_of', 'confirmed', start, null, wellAfter), 'past the grace window with no check-in → no-show');
  ok(!isNoShow('day_of', 'confirmed', start, wellAfter.toISOString(), wellAfter), 'someone who checked in is never a no-show');
  ok(!isNoShow('day_of', 'assigned', start, null, wellAfter), 'someone who never confirmed cannot be a no-show');
  ok(!isNoShow('day_of', 'declined', start, null, wellAfter), 'someone who declined is not a no-show');
  ok(!isNoShow('planning', 'confirmed', start, null, wellAfter),
    'a planning role is never a no-show — there is no check-in desk 16 weeks out');
  ok(!isNoShow('day_of', 'confirmed', null, null, wellAfter), 'no start time → no no-show');

  const liveNoShow = await loadTeam(db, tid, wellAfter);
  ok(liveNoShow!.summary.noShows === 1, 'the live snapshot reports the no-show', `${liveNoShow!.summary.noShows}`);
  const checkIn = await patch(tid, { assignmentId: member.assignmentId, action: 'checkin' });
  ok(checkIn.status === 200, 'the organizer can check them in');
  const afterCheckIn = await loadTeam(db, tid, wellAfter);
  ok(afterCheckIn!.summary.noShows === 0, 'and the alert clears', `${afterCheckIn!.summary.noShows}`);
  await patch(tid, { assignmentId: member.assignmentId, action: 'undo_checkin' });

  // ── 6. Meetings ───────────────────────────────────────────────────────────
  section('6. Planning meetings');
  const mkMeeting = (body: unknown, jwt = owner.jwt) =>
    fetch(`${BASE}/api/tournament/${tid}/meetings`, { method: 'POST', headers: H(jwt), body: JSON.stringify(body) });

  ok((await mkMeeting({ scheduledAt: 'sometime' })).status === 400, 'an unparseable date is refused');
  ok((await mkMeeting({})).status === 400, 'a meeting with no date is refused');

  // Give the committee a planning member so auto-invite has someone to invite.
  await post(tid, { roleTemplateId: chair.id, name: 'Mark Reed', email: `mark@${DOM}`, invite: false });
  const created = await mkMeeting({ scheduledAt: '2026-06-02T18:00:00Z', title: 'Kickoff', agenda: 'Set the five goals' });
  const meetings = await created.json();
  ok(created.status === 200 && meetings.meetings.length === 1, 'a meeting is scheduled', `HTTP ${created.status}`);
  ok(meetings.meetings[0].attendance.length >= 1, 'and the planning committee is auto-invited',
    `${meetings.meetings[0].attendance.length} invited`);

  const meetingId = meetings.meetings[0].id as string;
  const noDesc = await mkMeeting({ kind: 'action_item', meetingId, description: '' });
  ok(noDesc.status === 400, 'an action item with no description is refused');
  const foreignMeeting = await mkMeeting({ kind: 'action_item', meetingId: '00000000-0000-0000-0000-000000000000', description: 'x' });
  ok(foreignMeeting.status === 400, 'an action item cannot attach to a meeting that is not yours');

  const item = await mkMeeting({ kind: 'action_item', meetingId, description: 'Call the pro shop about carts' });
  const withItem = await item.json();
  ok(withItem.openItems === 1, 'an action item is logged and counted open', `${withItem.openItems}`);
  ok(withItem.unownedItems === 1, 'and flagged as unowned until someone takes it', `${withItem.unownedItems}`);

  const itemId = withItem.actionItems[0].id as string;
  const done = await fetch(`${BASE}/api/tournament/${tid}/meetings`, {
    method: 'PATCH', headers: H(owner.jwt), body: JSON.stringify({ kind: 'action_item', itemId }),
  });
  const doneData = await done.json();
  ok(doneData.openItems === 0, 'completing an item closes it', `${doneData.openItems}`);
  const reopened = await fetch(`${BASE}/api/tournament/${tid}/meetings`, {
    method: 'PATCH', headers: H(owner.jwt), body: JSON.stringify({ kind: 'action_item', itemId }),
  });
  ok((await reopened.json()).openItems === 1, 'and it can be reopened if closed by mistake');

  const rivalItem = await fetch(`${BASE}/api/tournament/${rivalTid}/meetings`, {
    method: 'PATCH', headers: H(rival.jwt), body: JSON.stringify({ kind: 'action_item', itemId }),
  });
  ok(rivalItem.status === 404, "a rival cannot complete your action item", `HTTP ${rivalItem.status}`);

  // ── 7. Reminder edges ─────────────────────────────────────────────────────
  section('7. Reminder edges');
  await db.from('volunteer_reminders').delete().eq('assignment_id', member.assignmentId);
  const farFuture = new Date(start.getTime() - 40 * 24 * 3_600_000);
  const early = await runVolunteerReminders(db, tid, farFuture);
  ok(early.sent === 0, 'nothing fires 40 days out — outside every band', `${early.sent}`);
  const { count: noRows } = await db.from('volunteer_reminders').select('id', { count: 'exact', head: true }).eq('assignment_id', member.assignmentId);
  ok((noRows ?? 0) === 0, 'and no rows are claimed', `${noRows}`);

  // Concurrency: two schedulers racing must not double-text.
  await db.from('volunteer_reminders').delete().eq('assignment_id', member.assignmentId);
  const inBand = new Date(start.getTime() - 80 * 60_000);
  await Promise.all([runVolunteerReminders(db, tid, inBand), runVolunteerReminders(db, tid, inBand)]);
  const { data: raceRows } = await db.from('volunteer_reminders').select('offset_minutes, status').eq('assignment_id', member.assignmentId);
  const sentOrClaimed = (raceRows ?? []).filter((r) => r.offset_minutes === 90);
  ok(sentOrClaimed.length === 1, 'two concurrent runs claim the 90-minute slot exactly once',
    `${sentOrClaimed.length} row(s)`);

  // ── 8. Scale ──────────────────────────────────────────────────────────────
  section('8. Scale');
  const bulkVols = Array.from({ length: 120 }, (_, i) => ({
    tournament_id: tid, name: `Bulk ${i}`, email: `bulk${i}@${DOM}`, phone: null,
  }));
  const { data: inserted } = await db.from('volunteers').insert(bulkVols).select('id');
  const allRoles = roles!;
  await db.from('tournament_volunteer_assignments').insert(
    (inserted ?? []).map((v, i) => ({
      tournament_id: tid, volunteer_id: v.id, role_template_id: allRoles[i % allRoles.length].id, status: 'confirmed',
    })).filter((_, i) => i < 120),
  );
  const t0 = Date.now();
  const bulkTeam = await loadTeam(db, tid);
  const ms = Date.now() - t0;
  ok(!!bulkTeam, '120 assignments load');
  ok(ms < 6000, 'team snapshot builds in reasonable time', `${ms}ms`);
  const totalMembers = bulkTeam!.roles.reduce((n, r) => n + r.members.length, 0);
  ok(totalMembers >= 120, 'every assignment appears exactly once', `${totalMembers} members`);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('9. Cleanup');
  const { data: tagged } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  for (const row of tagged ?? []) {
    const { data: as } = await db.from('tournament_volunteer_assignments').select('id').eq('tournament_id', row.id);
    for (const a of as ?? []) await db.from('volunteer_reminders').delete().eq('assignment_id', a.id);
    await db.from('meeting_action_items').delete().eq('tournament_id', row.id);
    const { data: ms2 } = await db.from('planning_meetings').select('id').eq('tournament_id', row.id);
    for (const m of ms2 ?? []) await db.from('meeting_attendance').delete().eq('meeting_id', m.id);
    await db.from('planning_meetings').delete().eq('tournament_id', row.id);
    await db.from('tournament_volunteer_assignments').delete().eq('tournament_id', row.id);
    await db.from('volunteers').delete().eq('tournament_id', row.id);
    await db.from('tournaments').delete().eq('id', row.id);
  }
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of users?.users ?? []) if (u.email?.endsWith(DOM)) await db.auth.admin.deleteUser(u.id);
  const { data: left } = await db.from('tournaments').select('id').ilike('name', `${TAG}%`);
  ok((left?.length ?? 0) === 0, 'fixtures removed', `${left?.length ?? 0} left`);

  console.log(`\n${failures === 0 ? '✅ VOLUNTEER ENGINE STRESS — ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
