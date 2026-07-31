// Day 28 — F&B plan persistence + Vendor Donation Engine verification.
//
// The model arithmetic is covered by verify-fb-calculator.ts. This file covers
// everything that touches the database: the headcount lock, the outreach
// funnel, the claim-before-send guard against double-emailing a vendor, and
// the 7-day follow-up cadence.
//
// The cadence is the risky one. A bug here doesn't show up as an exception —
// it shows up as a local business getting the same email four times, which is
// how a tournament loses a donor. So it is tested against fixed clocks at the
// exact boundaries, not "roughly a week".
//
//   npx tsx scripts/verify-donation-engine.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadFbPlan, saveFbInputs, shotgunInstant } from '../lib/fb/plan';
import {
  loadDonations, nextFollowUpAt, runDonationFollowups, sendDonationOutreach,
  FOLLOWUP_DUE_DAYS, MAX_FOLLOWUPS, CHASEABLE,
} from '../lib/donations/outreach';
import { buildKitchenSheet } from '../lib/email/kitchenSheet';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
// The libraries under test read process.env directly (askClaude, SendGrid), so
// mirror .env.local into it rather than only handing values to createClient.
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const TAG = 'ZZZ FBDON';
const DOM = 'fbdon.example.invalid';
const EVENT = '2026-10-10';
const SHOTGUN = '08:00';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function main() {
  // ── Schema gate ───────────────────────────────────────────────────────────
  const { error: schemaErr } = await db.from('fb_calculations').select('quantities, headcount_locked_at').limit(1);
  if (schemaErr) {
    console.log(`\n❌ Migration 041 has not been run — ${schemaErr.message}`);
    console.log('   Run db/migrations/041_fb_donations.sql in the Supabase SQL editor, then re-run this.');
    process.exit(1);
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${Date.now()}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  if (!owner?.user) throw new Error('could not create test organizer');

  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE`, city: 'Monterey', state: 'California', zip: '93940',
    total_holes: 18, par_total: 72, contact_email: `kitchen@${DOM}`,
  }).select('id').single();

  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: owner.user.id, course_id: course!.id,
    event_date: EVENT, shotgun_time: SHOTGUN, format: 'scramble',
    max_players: 72, entry_fee_cents: 16500, status: 'draft',
    cause_org: 'Monterey Youth Golf', cause_tagline: 'Clubs in the hands of kids who cannot afford them',
    cause_story_short: 'Last year we put 340 kids through a free eight-week junior clinic.',
  }).select('id').single();
  const tid = t!.id;

  // 18 foursomes = 72 players, matching the worked example. Errors here are
  // thrown rather than ignored — a silently-empty fixture set produced a wall
  // of confusing failures further down instead of one clear message.
  const regErr = await db.from('registrations').insert(
    Array.from({ length: 18 }, (_, i) => ({
      tournament_id: tid, registration_type: 'foursome', payment_status: 'paid',
      contact_name: `${TAG} CAP ${i}`, contact_email: `cap${i}@${DOM}`,
    })),
  );
  if (regErr.error) throw new Error(`fixture registrations: ${regErr.error.message}`);
  // A refunded foursome and a sponsor package must NOT reach the kitchen.
  await db.from('registrations').insert([
    { tournament_id: tid, registration_type: 'foursome', payment_status: 'refunded', contact_name: `${TAG} REFUND`, contact_email: `ref@${DOM}` },
    { tournament_id: tid, registration_type: 'sponsor', payment_status: 'paid', contact_name: `${TAG} SPON`, contact_email: `spon@${DOM}` },
  ]);

  const cleanup = async () => {
    const { data: ps } = await db.from('donation_prospects').select('id').eq('tournament_id', tid);
    for (const p of ps ?? []) await db.from('donation_outreach_log').delete().eq('prospect_id', p.id);
    await db.from('donation_prospects').delete().eq('tournament_id', tid);
    await db.from('fb_calculations').delete().eq('tournament_id', tid);
    await db.from('registrations').delete().eq('tournament_id', tid);
    await db.from('tournaments').delete().eq('id', tid);
    await db.from('courses').delete().eq('id', course!.id);
    await db.auth.admin.deleteUser(owner.user!.id);
  };

  try {
    // ── Headcount ───────────────────────────────────────────────────────────
    section('1. Headcount comes from registrations, on the same rule as the goals dashboard');
    let plan = (await loadFbPlan(db, tid))!;
    ok(plan.livePlayerCount === 72, '18 paid foursomes = 72 players', String(plan.livePlayerCount));
    ok(plan.plan === null, 'no temperature yet means no plan at all — we never default to 75°F and call it weather-adjusted');

    await saveFbInputs(db, tid, {
      temperature_f: 78, precip_chance: null, weather_source: 'manual',
      weather_summary: 'Entered by hand: 78°F.', weather_fetched_at: new Date().toISOString(),
      volunteer_count: 12,
    });
    plan = (await loadFbPlan(db, tid))!;
    ok(plan.plan !== null, 'with a temperature, a plan appears');
    ok(plan.plan!.inputs.playerCount === 72 && plan.plan!.lunch.attendees === 84,
      'the refunded foursome and the sponsor package are excluded from both',
      `${plan.plan!.inputs.playerCount} players / ${plan.plan!.lunch.attendees} at lunch`);
    ok(plan.plan!.lines.find((l) => l.key === 'beer')!.packs === 10,
      'the persisted plan reproduces the worked example exactly');

    section('2. Headcount lock');
    await saveFbInputs(db, tid, { headcount_locked_at: new Date().toISOString(), locked_player_count: plan.livePlayerCount });
    // Someone registers after the lock.
    await db.from('registrations').insert({
      tournament_id: tid, registration_type: 'foursome', payment_status: 'paid',
      contact_name: `${TAG} LATE`, contact_email: `late@${DOM}`,
    });
    plan = (await loadFbPlan(db, tid))!;
    ok(plan.livePlayerCount === 76, 'registrations keep moving after the lock', String(plan.livePlayerCount));
    ok(plan.plan!.inputs.playerCount === 72, 'but the plan stays on the locked number — the kitchen order does not move');
    ok(plan.lockedPlayerCount === 72, 'the drift is visible so the organizer can decide whether to re-plan');

    section('3. Kitchen sheet');
    const sheet = buildKitchenSheet(plan);
    ok(sheet.text.includes('10 × cases') && sheet.text.includes('89 portions'),
      'the sheet carries orderable quantities, not raw servings');
    ok(sheet.text.includes('will not change'), 'and states that the headcount is locked');
    ok(/8:00\s*AM/.test(sheet.text) && /12:32\s*PM/.test(sheet.text),
      'the timeline shows real clock times back-timed from the shotgun');
    ok(!sheet.html.includes('<script'), 'the HTML sheet escapes its inputs');

    // Back to the worked example for the rest of the file: drop the late
    // registration, then unlock.
    await db.from('registrations').delete().eq('tournament_id', tid).eq('contact_name', `${TAG} LATE`);
    await saveFbInputs(db, tid, { headcount_locked_at: null, locked_player_count: null });

    // ── Donation engine ─────────────────────────────────────────────────────
    section('4. Prospects and the asks they inherit from the plan');
    const mk = async (company: string, category: string, email: string | null) => {
      const { data, error } = await db.from('donation_prospects').insert({
        tournament_id: tid, name: company, company, category, email, status: 'prospect',
      }).select('id').single();
      if (error) throw new Error(`insert prospect: ${error.message}`);
      return data!.id as string;
    };
    const distributor = await mk('Central Coast Beverage', 'beer_wine_distributor', `beer@${DOM}`);
    const caterer = await mk('Harbour House Catering', 'restaurant', `food@${DOM}`);
    const noEmail = await mk('Corner Liquor', 'liquor_store', null);

    let snap = await loadDonations(db, tid);
    ok(snap.hasFbPlan, 'the donation screen sees the F&B plan');
    const beerAsk = snap.asks.find((a) => a.key === 'beer_wine_distributor')!.ask!;
    ok(beerAsk.includes('10 cases') && beerAsk.includes('72 players'),
      'the distributor ask carries the exact computed quantity', beerAsk);
    ok(snap.summary.total === 3 && snap.summary.sent === 0, 'nothing counted as sent before anything is sent');
    ok(snap.summary.uncovered.length === 6, 'all six categories are uncovered until a vendor commits');

    section('5. Send guards');
    const noEmailResult = await sendDonationOutreach(db, tid, noEmail);
    ok(!noEmailResult.ok && /no email/i.test(noEmailResult.error ?? ''),
      'a prospect with no email is refused before anything is drafted or logged');
    const { data: strayLogs } = await db.from('donation_outreach_log').select('id').eq('prospect_id', noEmail);
    ok((strayLogs ?? []).length === 0, 'and leaves no log row behind');

    // Cross-tournament scoping: an id alone is not authorisation.
    const foreign = await sendDonationOutreach(db, tid, '00000000-0000-0000-0000-000000000000');
    ok(!foreign.ok, 'an id from another tournament is refused');

    section('6. Claim-before-send stops a vendor being emailed twice');
    // Simulate a first send that has already happened.
    await db.from('donation_prospects').update({
      status: 'sent', sent_at: daysAgo(8), last_contact_at: daysAgo(8), follow_up_count: 0,
    }).eq('id', distributor);
    await db.from('donation_outreach_log').insert({
      prospect_id: distributor, tournament_id: tid, method: 'email', direction: 'outbound',
      outcome: 'sent', subject: 'first', body: 'first', follow_up_number: 0, contacted_at: daysAgo(8),
    });

    const dupe = await db.from('donation_outreach_log').insert({
      prospect_id: distributor, tournament_id: tid, method: 'email', direction: 'outbound',
      outcome: 'sent', subject: 'again', body: 'again', follow_up_number: 0,
    });
    ok(dupe.error?.code === '23505',
      'a second outbound row for the same attempt is rejected by the database, not by hopeful application logic',
      dupe.error?.code ?? 'no error');

    // An inbound reply is NOT an outbound attempt and must not collide.
    const inbound = await db.from('donation_outreach_log').insert({
      prospect_id: distributor, tournament_id: tid, method: 'email', direction: 'inbound',
      outcome: 'replied', subject: 'Re: first', body: 'sounds good', follow_up_number: 0,
    });
    ok(!inbound.error, 'an inbound reply with the same number is allowed — the index is scoped to outbound');
    await db.from('donation_outreach_log').delete().eq('prospect_id', distributor).eq('direction', 'inbound');

    section('7. The 7-day cadence, at the boundaries');
    ok(nextFollowUpAt({ status: 'sent', follow_up_count: 0, last_contact_at: daysAgo(0) }) !== null,
      'a freshly-sent prospect has a follow-up scheduled');
    ok(nextFollowUpAt({ status: 'responded', follow_up_count: 0, last_contact_at: daysAgo(30) }) === null,
      'a prospect who replied is never chased again');
    ok(nextFollowUpAt({ status: 'committed', follow_up_count: 0, last_contact_at: daysAgo(30) }) === null,
      'nor is one who committed');
    ok(nextFollowUpAt({ status: 'declined', follow_up_count: 0, last_contact_at: daysAgo(30) }) === null,
      'nor one who declined');
    ok(nextFollowUpAt({ status: 'sent', follow_up_count: MAX_FOLLOWUPS, last_contact_at: daysAgo(30) }) === null,
      `the cadence stops dead at ${MAX_FOLLOWUPS} attempts`);
    ok(nextFollowUpAt({ status: 'prospect', follow_up_count: 0, last_contact_at: daysAgo(30) }) === null,
      'someone never contacted is not "overdue for a follow-up"');
    const due = nextFollowUpAt({ status: 'sent', follow_up_count: 0, last_contact_at: daysAgo(FOLLOWUP_DUE_DAYS) })!;
    ok(Date.parse(due) <= Date.now(), `${FOLLOWUP_DUE_DAYS} days on the dot is due`);
    ok(CHASEABLE.every((s) => !['responded', 'committed', 'declined'].includes(s)),
      'no resolved status is in the chaseable set');

    // The cron's own query, against real rows.
    section('8. The cron picks exactly the right rows');
    await db.from('donation_prospects').update({
      status: 'opened', last_contact_at: daysAgo(9), follow_up_count: 0,
    }).eq('id', caterer);
    // A third prospect who replied 30 days ago must be left alone.
    const replied = await mk('Bayside Roasters', 'coffee_shop', `coffee@${DOM}`);
    await db.from('donation_prospects').update({
      status: 'responded', last_contact_at: daysAgo(30), follow_up_count: 0,
    }).eq('id', replied);
    // And one contacted only 2 days ago.
    const recent = await mk('Peninsula Foods', 'food_supplier', `foods@${DOM}`);
    await db.from('donation_prospects').update({
      status: 'sent', last_contact_at: daysAgo(2), follow_up_count: 0,
    }).eq('id', recent);

    const { data: cronRows } = await db.from('donation_prospects')
      .select('id, company')
      .eq('tournament_id', tid)
      .in('status', CHASEABLE)
      .lt('follow_up_count', MAX_FOLLOWUPS)
      .lte('last_contact_at', new Date(Date.now() - FOLLOWUP_DUE_DAYS * 86_400_000).toISOString())
      .not('email', 'is', null);
    const picked = new Set((cronRows ?? []).map((r) => r.id as string));
    ok(picked.size === 2 && picked.has(distributor) && picked.has(caterer),
      'exactly the two overdue, unresolved, emailable prospects are picked up',
      `${picked.size} rows`);
    ok(!picked.has(replied), 'the one who replied is excluded');
    ok(!picked.has(recent), 'the one contacted 2 days ago is excluded');
    ok(!picked.has(noEmail), 'the one with no email is excluded');

    section('9. The cadence run itself');
    // SendGrid is deliberately not exercised against real vendors here. The
    // run is expected to fail at the send step; what matters is that failure
    // is recorded rather than swallowed, and that it does not advance the
    // counter into a state where a real send would be skipped.
    const before = await loadDonations(db, tid);
    const run = await runDonationFollowups(db);
    const mine = run.details.filter((d) => picked.has(d.prospectId));
    ok(mine.length === 2, 'the run considered both due prospects', `${mine.length}`);

    const after = await loadDonations(db, tid);
    const dist = after.prospects.find((p) => p.id === distributor)!;
    const distBefore = before.prospects.find((p) => p.id === distributor)!;

    if (mine.every((d) => d.ok)) {
      ok(dist.followUpCount === distBefore.followUpCount + 1, 'a successful follow-up advances the counter by exactly one');
      ok(dist.followUpCount <= MAX_FOLLOWUPS, 'and never past the cap');
    } else {
      const { data: failedLogs } = await db.from('donation_outreach_log')
        .select('outcome, error, follow_up_number').eq('prospect_id', distributor).eq('follow_up_number', 1);
      ok((failedLogs ?? []).length === 1, 'a failed send leaves exactly one log row, marked failed');
      ok((failedLogs ?? [])[0]?.outcome === 'failed' && !!(failedLogs ?? [])[0]?.error,
        'with the real error recorded rather than swallowed',
        (failedLogs ?? [])[0]?.error?.slice(0, 60) ?? 'none');
      ok(dist.followUpCount === distBefore.followUpCount,
        'and does NOT advance the counter — a vendor who was never emailed should still be chased');
    }

    // Whatever happened, running again must not double up.
    const rerun = await runDonationFollowups(db);
    const rerunMine = rerun.details.filter((d) => picked.has(d.prospectId));
    const { data: allLogs } = await db.from('donation_outreach_log')
      .select('follow_up_number').eq('prospect_id', distributor).eq('direction', 'outbound');
    const numbers = (allLogs ?? []).map((l) => l.follow_up_number as number);
    ok(new Set(numbers).size === numbers.length,
      'a second cron run in the same window never produces a duplicate attempt number',
      `attempts: [${numbers.sort().join(', ')}]`);
    ok(rerunMine.every((d) => d.ok || !!d.error), 'and every outcome is accounted for');

    section('10. Outcomes and the funnel');
    await db.from('donation_prospects').update({
      status: 'committed', committed_at: new Date().toISOString(), committed_value_cents: 48_000,
    }).eq('id', distributor);
    snap = await loadDonations(db, tid);
    ok(snap.summary.committed === 1 && snap.summary.committedValueCents === 48_000,
      'a commitment counts, with its value', `$${snap.summary.committedValueCents / 100}`);
    ok(snap.summary.uncovered.length === 5 && !snap.summary.uncovered.some((u) => u.key === 'beer_wine_distributor'),
      'and the beer category drops off the uncovered list');
    ok(snap.prospects.find((p) => p.id === distributor)!.nextFollowUpAt === null,
      'a committed vendor is no longer scheduled for anything');

    section('12. Outreach tracking webhooks');
    // These call OUR webhook handlers with the payload shapes SendGrid posts.
    // That proves the attribution logic — which prospect an open belongs to,
    // and which status transitions are allowed — without depending on
    // SendGrid actually reaching this machine. Real end-to-end delivery of an
    // event still needs the webhook URL configured in the SendGrid dashboard.
    const { POST: eventHook } = await import('../app/api/webhooks/sendgrid/route');
    const { POST: inboundHook } = await import('../app/api/webhooks/sendgrid-inbound/route');
    const { NextRequest } = await import('next/server');

    const postEvents = (events: unknown[]) => eventHook(new NextRequest('http://localhost/api/webhooks/sendgrid', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(events),
    }));

    // A fresh prospect, sent but not yet opened.
    const tracked = await mk('Gulf Coast Wine', 'liquor_store', `wine@${DOM}`);
    await db.from('donation_prospects').update({ status: 'sent', sent_at: daysAgo(1), last_contact_at: daysAgo(1) }).eq('id', tracked);

    await postEvents([{ event: 'open', prospect_id: tracked, timestamp: Math.floor(Date.now() / 1000) }]);
    let { data: row } = await db.from('donation_prospects')
      .select('status, email_opens, opened_at').eq('id', tracked).single();
    ok(row?.status === 'opened', 'an open event moves the prospect from Sent to Opened', String(row?.status));
    ok(row?.email_opens === 1 && !!row?.opened_at, 'and records the open count and first-open time', `${row?.email_opens} opens`);

    await postEvents([{ event: 'open', prospect_id: tracked }, { event: 'click', prospect_id: tracked }]);
    ({ data: row } = await db.from('donation_prospects').select('status, email_opens').eq('id', tracked).single());
    ok(row?.email_opens === 2, 'a second open increments; a click does not inflate the open count', `${row?.email_opens} opens`);

    // A late open must never drag a resolved prospect backwards.
    await db.from('donation_prospects').update({ status: 'committed' }).eq('id', tracked);
    await postEvents([{ event: 'open', prospect_id: tracked }]);
    ({ data: row } = await db.from('donation_prospects').select('status').eq('id', tracked).single());
    ok(row?.status === 'committed', 'a late open does not drag a committed vendor back to "opened"', String(row?.status));

    // A sponsor-tagged event must not touch donation rows, and vice versa.
    await db.from('donation_prospects').update({ status: 'sent', email_opens: 0 }).eq('id', tracked);
    await postEvents([{ event: 'open', sponsor_id: tracked }]);
    ({ data: row } = await db.from('donation_prospects').select('status, email_opens').eq('id', tracked).single());
    ok(row?.status === 'sent' && row?.email_opens === 0,
      'an event tagged sponsor_id never touches a donation prospect with the same id');

    // Inbound reply: stops the cadence and files the conversation.
    const form = new FormData();
    form.set('envelope', JSON.stringify({ to: [`reply-${tracked}@reply.tourneycoach.com`] }));
    form.set('to', `reply-${tracked}@reply.tourneycoach.com`);
    form.set('from', 'Dana Whitfield <dana@gulfcoastwine.example>');
    form.set('subject', 'Re: Donation request');
    form.set('text', 'Happy to help — we can cover 6 cases.\n\nOn Tue someone wrote:\n> original');
    await inboundHook(new NextRequest('http://localhost/api/webhooks/sendgrid-inbound', { method: 'POST', body: form }));

    const { data: replied2 } = await db.from('donation_prospects')
      .select('status, responded_at, reply_snippet').eq('id', tracked).single();
    const snippet = (replied2?.reply_snippet as string | null) ?? '';
    ok(replied2?.status === 'responded', 'a reply moves the prospect to Responded', String(replied2?.status));
    ok(snippet.includes('6 cases') && !snippet.includes('> original'),
      'the snippet keeps their words and strips the quoted history', snippet || 'none');
    ok(nextFollowUpAt({ status: replied2!.status as string, follow_up_count: 0, last_contact_at: daysAgo(30) }) === null,
      'and the follow-up cadence stops immediately');

    const { data: inLog } = await db.from('donation_outreach_log')
      .select('direction, outcome, subject').eq('prospect_id', tracked).eq('direction', 'inbound');
    ok((inLog ?? []).length === 1 && inLog![0].outcome === 'replied',
      'the reply is filed in the outreach history as an inbound entry');

    // An unknown reply address must be ignored, not crash or mis-attribute.
    const stray = new FormData();
    stray.set('to', 'reply-00000000-0000-0000-0000-000000000000@reply.tourneycoach.com');
    stray.set('from', 'nobody@example.invalid');
    stray.set('subject', 'hello');
    stray.set('text', 'hello');
    const strayRes = await inboundHook(new NextRequest('http://localhost/api/webhooks/sendgrid-inbound', { method: 'POST', body: stray }));
    ok(strayRes.status === 200, 'a reply to an unknown address is acknowledged and ignored');

    section('11. Shotgun instant');
    // Real rows in this database hold "8:30 am", not "08:30". Getting this
    // wrong shifts every step of the kitchen timeline.
    ok(shotgunInstant(EVENT, '8:30 am') === '2026-10-10T08:30:00.000Z', 'lowercase "8:30 am" parses');
    ok(shotgunInstant(EVENT, '8:30 AM') === '2026-10-10T08:30:00.000Z', 'uppercase "8:30 AM" parses');
    ok(shotgunInstant(EVENT, '1:00 pm') === '2026-10-10T13:00:00.000Z', 'pm converts to 24-hour');
    ok(shotgunInstant(EVENT, '12:00 am') === '2026-10-10T00:00:00.000Z', 'midnight is 00:00, not 12:00');
    ok(shotgunInstant(EVENT, '12:30 pm') === '2026-10-10T12:30:00.000Z', 'noon stays 12:00');
    ok(shotgunInstant(EVENT, SHOTGUN) === '2026-10-10T08:00:00.000Z', 'date + time combine correctly');
    ok(!!shotgunInstant(EVENT, null)?.endsWith('T08:00:00.000Z'), 'a missing shotgun time falls back to 8am');
    ok(shotgunInstant(null, SHOTGUN) === null, 'no event date means no instant');
    ok(!!shotgunInstant(EVENT, 'garbage')?.endsWith('T08:00:00.000Z'), 'a malformed time does not produce an invalid date');
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(failures === 0
    ? '\n✅ DONATION ENGINE — ALL CHECKS PASSED'
    : `\n❌ DONATION ENGINE — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
