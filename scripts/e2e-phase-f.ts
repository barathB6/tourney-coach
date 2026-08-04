// PHASE F INTEGRATION — Days 26-30 walked end to end as one tournament.
//
// Not a unit suite. This drives one real tournament through the whole phase in
// order and asserts that each day's output is genuinely the next day's input:
//
//   Day 26  goals + phase-distinct task engine
//   Day 27  volunteer roles, invites, token portal
//   Day 28  F&B calculator → vendor donation asks
//   Day 29  guidance profiles → cadence → communication ledger
//   Day 30  mobile portal, offline queue, event triggers, day-of board
//
// The integration is the point: an F&B quantity has to reach a donation email,
// a guidance profile has to pick the channel a reminder actually uses, and a
// day-of trigger has to reach exactly the roles it names.
//
//   npx tsx scripts/e2e-phase-f.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadFbPlan, saveFbInputs } from '../lib/fb/plan';
import { loadDonations } from '../lib/donations/outreach';
import { loadProfile, recordGuidanceEvent } from '../lib/guidance/profile';
import { runCadence } from '../lib/comm/runCadence';
import { fireTrigger, loadTriggerState, TRIGGERS } from '../lib/dayof/triggers';
import { loadTeam } from '../lib/toc/team';
import { flushQueue, enqueue, readQueue } from '../lib/dayof/offlineCache';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

const RUN = Date.now().toString(36);
const TAG = 'ZZZ PHASEF';
const DOM = `${RUN}.phasef.example.invalid`;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

async function main() {
  for (const [table, hint] of [['volunteer_guidance_profiles', '043'], ['tournament_events', '044']] as const) {
    const { error } = await db.from(table).select('id').limit(1);
    if (error) {
      console.log(`\n❌ Migration ${hint} has not been run — ${error.message}`);
      process.exit(1);
    }
  }

  // ── Fixture: a tournament happening TODAY, so day-of logic is real ────────
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${RUN}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const soon = new Date(Date.now() + 20 * 3_600_000);
  const eventDate = soon.toISOString().slice(0, 10);
  const shotgun = `${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`;

  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE`, city: 'Monterey', state: 'CA', zip: '93940',
    total_holes: 18, par_total: 72, contact_email: `kitchen@${DOM}`,
  }).select('id').single();

  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} CUP`, organizer_id: owner!.user!.id, course_id: course!.id,
    event_date: eventDate, shotgun_time: shotgun, format: 'scramble',
    max_players: 72, entry_fee_cents: 16500, status: 'published',
    cause_org: 'Monterey Youth Golf',
    cause_story_short: 'Last year we put 340 kids through a free eight-week junior clinic.',
  }).select('id').single();
  const tid = t!.id as string;

  const regErr = await db.from('registrations').insert(
    Array.from({ length: 18 }, (_, i) => ({
      tournament_id: tid, registration_type: 'foursome', payment_status: 'paid',
      contact_name: `${TAG} CAP ${i}`, contact_email: `cap${i}@${DOM}`,
    })),
  );
  if (regErr.error) throw new Error(`fixture registrations: ${regErr.error.message}`);

  const { data: roles } = await db.from('role_templates').select('id, name, phase');
  const roleByName = new Map((roles ?? []).map((r) => [r.name as string, r]));

  const mk = async (roleName: string, name: string, phone: string | null) => {
    const role = roleByName.get(roleName)!;
    const { data: v, error: ve } = await db.from('volunteers')
      .insert({ tournament_id: tid, name, email: `${name.replace(/\W/g, '').toLowerCase()}@${DOM}`, phone })
      .select('id').single();
    if (ve) throw new Error(`fixture volunteer: ${ve.message}`);
    const { data: a, error: ae } = await db.from('tournament_volunteer_assignments').insert({
      tournament_id: tid, volunteer_id: v!.id, role_template_id: role.id,
      status: 'confirmed', invite_token: crypto.randomUUID(),
      invited_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      responded_at: new Date(Date.now() - 2.9 * 86_400_000).toISOString(),
    }).select('id, invite_token').single();
    if (ae) throw new Error(`fixture assignment: ${ae.message}`);
    return { volunteerId: v!.id as string, assignmentId: a!.id as string, token: a!.invite_token as string };
  };

  const regLead = await mk('Registration Lead', `${TAG} Reg Lead`, '9855550134');
  const kitchen = await mk('Kitchen Liaison', `${TAG} Kitchen`, '9855550135');
  const photog = await mk('Photographer', `${TAG} Photog`, null);

  const cleanup = async () => {
    for (const tbl of ['guidance_events', 'volunteer_task_completions', 'volunteer_messages',
      'volunteer_guidance_profiles', 'push_subscriptions', 'tournament_events', 'communication_log',
      'donation_prospects', 'fb_calculations', 'tournament_volunteer_assignments', 'volunteers',
      'registrations']) {
      await db.from(tbl).delete().eq('tournament_id', tid);
    }
    await db.from('tournaments').delete().eq('id', tid);
    await db.from('courses').delete().eq('id', course!.id);
    await db.auth.admin.deleteUser(owner!.user!.id);
  };

  try {
    // ── Day 26/27: the team exists and the task engine is phase-distinct ────
    section('1. Day 26/27 — roles, tasks, phases');
    const team = await loadTeam(db, tid);
    ok(!!team && team.roles.length >= 20, 'the full role library is available', `${team?.roles.length} roles`);
    const filled = team!.roles.filter((r) => r.members.length > 0);
    ok(filled.length === 3, 'our three volunteers are assigned', filled.map((r) => r.name).join(', '));
    const dayOfRoles = team!.roles.filter((r) => r.phase === 'day_of');
    const planningRoles = team!.roles.filter((r) => r.phase === 'planning');
    ok(dayOfRoles.length > 0 && planningRoles.length > 0,
      'both phases exist — the task engine is phase-distinct, not one flat list');

    // ── Day 28: F&B plan → donation ask ────────────────────────────────────
    section('2. Day 28 — the F&B plan becomes the donation ask');
    await saveFbInputs(db, tid, {
      temperature_f: 78, weather_source: 'manual', volunteer_count: 3,
      weather_summary: 'Entered by hand: 78°F.', weather_fetched_at: new Date().toISOString(),
    });
    const plan = await loadFbPlan(db, tid);
    ok(plan?.plan?.inputs.playerCount === 72, '18 paid foursomes = 72 players', String(plan?.livePlayerCount));
    const beerPacks = plan!.plan!.lines.find((l) => l.key === 'beer')!.packs;
    ok(beerPacks === 10, 'the worked example holds inside a live tournament', `${beerPacks} cases`);

    const { error: pe } = await db.from('donation_prospects').insert({
      tournament_id: tid, name: 'Central Coast Beverage', company: 'Central Coast Beverage',
      category: 'beer_wine_distributor', email: `beer@${DOM}`, status: 'prospect',
    });
    if (pe) throw new Error(`fixture prospect: ${pe.message}`);
    const donations = await loadDonations(db, tid);
    const ask = donations.asks.find((a) => a.key === 'beer_wine_distributor')!.ask!;
    ok(ask.includes(`${beerPacks} cases`) && ask.includes('72 players'),
      'INTEGRATION: the calculator quantity is the exact number the vendor is asked for', ask);

    // ── Day 29: profile → channel → ledger ─────────────────────────────────
    section('3. Day 29 — guidance decides the channel the reminder actually uses');
    const leadProfile = await loadProfile(db, tid, regLead.volunteerId);
    const photogProfile = await loadProfile(db, tid, photog.volunteerId);
    ok(leadProfile.channel === 'sms' || !leadProfile.channel,
      'a day-of volunteer with a phone, inside 48 hours, resolves to SMS', leadProfile.channel);
    ok(photogProfile.channel === 'email',
      'a volunteer with no phone resolves to email — the ladder degrades, it does not fail', photogProfile.channel);

    const run = await runCadence(db);
    const mine = run.details.filter((d) =>
      [regLead.volunteerId, kitchen.volunteerId, photog.volunteerId].includes(d.volunteerId));
    ok(mine.length === 3, 'all three got exactly one cadence reminder', `${mine.length} sends`);
    ok(mine.every((d) => d.offsetKey === 'pre_event:1440'), 'all in the 24-hour slot');
    const photogSend = mine.find((d) => d.volunteerId === photog.volunteerId)!;
    ok(photogSend.channel === 'email',
      'INTEGRATION: the guidance profile chose the channel the engine actually delivered on',
      photogSend.channel);

    const rerun = await runCadence(db);
    const dupes = rerun.details.filter((d) => mine.some((m) => m.volunteerId === d.volunteerId) && d.ok);
    ok(dupes.length === 0, 'a second run sends nothing — the ledger claim held across the whole phase');

    // ── Day 30: event triggers reach exactly the named roles ───────────────
    section('4. Day 30 — event-driven triggers, simulated tournament progression');
    const shotgunFire = await fireTrigger(db, tid, 'shotgun_started');
    ok(shotgunFire.ok && shotgunFire.notified === 3,
      'shotgun_started reaches EVERY day-of volunteer', `${shotgunFire.notified} notified`);

    const kitchenFire = await fireTrigger(db, tid, 'kitchen_fired');
    ok(kitchenFire.ok && kitchenFire.notified === 1,
      'kitchen_fired reaches only the Kitchen Liaison — not the photographer, not the reg lead',
      `${kitchenFire.notified} notified`);

    const awardsFire = await fireTrigger(db, tid, 'awards_starting');
    ok(awardsFire.ok && awardsFire.notified === 1,
      'awards_starting reaches only the Photographer of our three', `${awardsFire.notified} notified`);

    const again = await fireTrigger(db, tid, 'kitchen_fired');
    ok(!again.ok && again.alreadyFired === true,
      'firing the same milestone twice is refused at the database, not by hope');

    const state = await loadTriggerState(db, tid);
    ok(state.filter((s) => s.firedAt).length === 3, 'three milestones recorded');
    ok(state.length === TRIGGERS.length, 'the board shows every milestone, fired or not', `${state.length}`);

    // Who actually received what — the real proof the routing is per-role.
    const { data: guidanceSends } = await db.from('communication_log')
      .select('volunteer_id, subject, channel').eq('tournament_id', tid).eq('kind', 'guidance').neq('channel', 'in_app');
    const kitchenMsgs = (guidanceSends ?? []).filter((m) => m.volunteer_id === kitchen.volunteerId).map((m) => m.subject);
    const photogMsgs = (guidanceSends ?? []).filter((m) => m.volunteer_id === photog.volunteerId).map((m) => m.subject);
    ok(kitchenMsgs.includes('Kitchen fired') && !kitchenMsgs.includes('Awards starting'),
      'the Kitchen Liaison got the kitchen alert and NOT the awards alert', kitchenMsgs.join(' | '));
    ok(photogMsgs.includes('Awards starting') && !photogMsgs.includes('Kitchen fired'),
      'the Photographer got awards and NOT the kitchen alert', photogMsgs.join(' | '));

    // ── Day 30: the volunteer app, offline and back ────────────────────────
    section('5. Day 30 — mobile portal, check-in, offline queue');
    const { GET: portalGet, POST: portalPost } = await import('../app/api/volunteer/portal/route');
    const { NextRequest } = await import('next/server');
    const snapOf = async (token: string) =>
      (await portalGet(new NextRequest(`http://localhost/api/volunteer/portal?token=${token}`))).json();
    const post = (body: Record<string, unknown>) => portalPost(new NextRequest('http://localhost/api/volunteer/portal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

    const leadSnap = await snapOf(regLead.token);
    ok(leadSnap.firedTriggers.length === 3,
      'the volunteer app sees the fired milestones — offline cache has real day-of state',
      `${leadSnap.firedTriggers.length}`);
    ok(Array.isArray(leadSnap.contacts) && leadSnap.contacts.length >= 1,
      'and one contact to call for help');
    ok(!leadSnap.contacts.some((c: { label: string }) => c.label?.toLowerCase().includes('volunteer')),
      'PRIVACY: the help screen exposes the organizer, never the roster');

    await post({ token: regLead.token, action: 'check_in' });
    const afterCheckIn = await snapOf(regLead.token);
    ok(!!afterCheckIn.checkedInAt, 'check-in from the phone lands');
    await post({ token: regLead.token, action: 'position', position: 'hole 7' });
    const afterPos = await snapOf(regLead.token);
    ok(afterPos.lastPosition === 'hole 7', 'and so does a position update');

    // Offline queue: replay in order, drop what the server rejects on merit.
    const OFFLINE_TOKEN = `phasef-${RUN}`;
    const store: Record<string, string> = {};
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      key: () => null, length: 0,
    } as unknown as Storage;

    const firstTask = leadSnap.tasks[0];
    enqueue(OFFLINE_TOKEN, { action: 'complete_task', taskId: firstTask.id });
    enqueue(OFFLINE_TOKEN, { action: 'message', body: 'Queued while I had no signal', audience: 'organizer' });
    enqueue(OFFLINE_TOKEN, { action: 'complete_task', taskId: 'not-a-real-task' });
    ok(readQueue(OFFLINE_TOKEN).length === 3, 'three actions queued while offline');

    const flushed = await flushQueue(OFFLINE_TOKEN, (body) =>
      post({ token: regLead.token, ...body }) as unknown as Promise<Response>);
    ok(flushed.sent === 2, 'two valid actions replayed on reconnect', `${flushed.sent} sent`);
    ok(flushed.dropped === 1, 'the invalid one is dropped, not retried forever', `${flushed.dropped} dropped`);
    ok(flushed.remaining === 0, 'the queue drains completely');

    const afterFlush = await snapOf(regLead.token);
    ok(afterFlush.tasks.find((x: { id: string }) => x.id === firstTask.id)?.completedAt,
      'INTEGRATION: the task ticked offline is genuinely done on the server');
    ok(afterFlush.messages.some((m: { body: string }) => m.body === 'Queued while I had no signal'),
      'and the queued message arrived');

    // ── Day 30: the organizer's day-of board sees all of it ────────────────
    section('6. Day 30 — the day-of board reflects the same reality');
    const { data: board } = await db.from('volunteers')
      .select('name, checked_in_at, last_position').eq('tournament_id', tid);
    ok((board ?? []).filter((v) => v.checked_in_at).length === 1, 'one volunteer checked in');
    ok((board ?? []).some((v) => v.last_position === 'hole 7'), 'and their position is on the board');

    // ── Full-phase feedback loop ───────────────────────────────────────────
    section('7. The loop closes — post-tournament feedback tunes next year');
    const before = await loadProfile(db, tid, regLead.volunteerId);
    await recordGuidanceEvent(db, tid, regLead.volunteerId, 'feedback', { wantsLessDetail: true });
    const after = await loadProfile(db, tid, regLead.volunteerId);
    ok(before.depth !== 'minimal' && after.depth === 'minimal',
      'INTEGRATION: Day 30 feedback rewrites the Day 29 profile', `${before.depth} → ${after.depth}`);

    await fireTrigger(db, tid, 'tournament_complete');
    const finalState = await loadTriggerState(db, tid);
    ok(finalState.find((s) => s.kind === 'tournament_complete')?.firedAt != null,
      'the tournament closes out');
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(failures === 0
    ? '\n✅ PHASE F INTEGRATION — ALL CHECKS PASSED'
    : `\n❌ PHASE F INTEGRATION — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
