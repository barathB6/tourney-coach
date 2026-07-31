// Day 28 stress test — F&B calculator + Vendor Donation Engine under abuse.
//
// verify-fb-calculator.ts proves the model is right; verify-donation-engine.ts
// proves the happy paths against the real database. This file goes after the
// ways it breaks in production: concurrent sends racing for the same claim,
// hostile strings ending up on a printed sign or in a kitchen email, absurd
// scales, and drift between two calls that should be identical.
//
//   npx tsx scripts/stress-fb-donations.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { calculateFb, heatMultiplier, pluralUnit } from '../lib/fb/calculator';
import { buildPrepTimeline } from '../lib/fb/calculator';
import { askFor, VENDOR_CATEGORIES } from '../lib/donations/vendors';
import { buildDonorWall } from '../lib/donations/donorWall';
import { buildTaxLetter } from '../lib/donations/taxLetter';
import { buildScript } from '../lib/donations/scripts';
import { buildKitchenSheet } from '../lib/email/kitchenSheet';
import { loadFbPlan, saveFbInputs, parseShotgunTime } from '../lib/fb/plan';
import { sendDonationOutreach, loadDonations, runDonationFollowups, MAX_FOLLOWUPS } from '../lib/donations/outreach';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const TAG = 'ZZZ FBSTRESS';
const DOM = 'fbstress.example.invalid';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const XSS = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
const EMOJI = 'Ölmüller & Søns 🍺 麦酒 «Пиво»';

async function main() {
  // ── Pure-model stress: no DB needed ──────────────────────────────────────
  section('1. Calculator sweep — 40°F to 110°F × three field sizes, nothing degenerate');
  let bad = 0;
  for (let t = 40; t <= 110; t++) {
    for (const players of [1, 72, 4096]) {
      const p = calculateFb({ playerCount: players, temperatureF: t, precipChance: t % 100 });
      for (const l of p.lines) {
        if (!Number.isInteger(l.packs) || l.packs < 0 || !Number.isFinite(l.units)
          || l.packedUnits < l.units || l.units < 0) bad++;
      }
      if (p.lunch.vegetarianPortions + p.lunch.standardPortions !== p.lunch.portions) bad++;
    }
  }
  ok(bad === 0, '213 temperatures × 3 field sizes: integer packs, coverage never short', `${bad} violations`);

  section('2. Determinism');
  const a = calculateFb({ playerCount: 72, temperatureF: 78, volunteerCount: 12, menu: ['x'], shotgunAt: '2026-10-10T08:00:00Z' });
  const b = calculateFb({ playerCount: 72, temperatureF: 78, volunteerCount: 12, menu: ['x'], shotgunAt: '2026-10-10T08:00:00Z' });
  ok(JSON.stringify(a) === JSON.stringify(b), 'same inputs twice → byte-identical plan');
  ok(heatMultiplier(78.0000001) - heatMultiplier(78) < 1e-6, 'no discontinuity at the worked-example temperature');

  section('3. Hostile strings survive every renderer');
  const hostilePlan = calculateFb({ playerCount: 72, temperatureF: 78, menu: [XSS, EMOJI] });
  const sheet = buildKitchenSheet({
    tournamentId: 'x', tournamentName: XSS, eventDate: '2026-10-10', shotgunTime: '8:30 am',
    shotgunAt: '2026-10-10T08:30:00.000Z', livePlayerCount: 72, lockedPlayerCount: 72,
    headcountLockedAt: daysAgo(1), handedOffAt: null, volunteerCount: 0, guestCount: 0, holes: 18,
    weather: { temperatureF: 78, precipChance: null, source: 'manual', summary: null, fetchedAt: null },
    baselines: { beer: 3, water: 3, soft_drinks: 1, sports_drinks: 0.6, snacks: 1.5 },
    menu: [XSS], plan: hostilePlan, hasCoordinates: false,
  });
  ok(!sheet.html.includes('<script'), 'script tags in the tournament name never reach the kitchen email HTML');
  ok(sheet.html.includes('&lt;script&gt;'), 'they are escaped, not stripped — the text is preserved');

  const wall = buildDonorWall([
    { company: XSS, category: 'restaurant', status: 'committed', committedValueCents: 1, askSummary: XSS },
    { company: EMOJI, category: 'coffee_shop', status: 'committed', committedValueCents: null, askSummary: null },
  ]);
  ok(wall.total === 2 && wall.plainText.includes(EMOJI), 'unicode/emoji donor names print intact on the wall');

  const letter = buildTaxLetter({
    charityLegalName: XSS, charityEin: '12-3456789', charityAddress: EMOJI, tournamentName: null,
    eventDate: '2026-10-10', organizerName: EMOJI, company: XSS, contactName: null,
    donationDescription: XSS, receivedDate: null, benefitsProvided: null,
  });
  ok(letter.body.includes(XSS) && !/\$\s?\d/.test(letter.body),
    'the letter is plain text (no HTML context) and still states no dollar value');

  const script = buildScript('restaurant', hostilePlan, {
    tournamentName: EMOJI, causeOrg: XSS, eventDateLabel: 'October 10',
    locationName: null, playerCount: 72, organizerName: null,
  });
  ok(script.lines.every((l) => typeof l.say === 'string' && l.say.length > 0), 'scripts render with hostile context');

  section('4. Shotgun-time fuzz');
  const junk = ['25:00', '8:99', '-3:00', '8:30 xm', '99', '  ', '8;30 am', '13:00 pm', '0:00', '23:59'];
  let crashed = 0;
  for (const j of junk) { try { parseShotgunTime(j); } catch { crashed++; } }
  ok(crashed === 0, 'no shotgun-time string crashes the parser');
  ok(parseShotgunTime('25:00') === null && parseShotgunTime('8:99') === null, 'out-of-range times are rejected, not wrapped');
  ok(parseShotgunTime('23:59')!.hour === 23, '23:59 is legitimate');
  // "13:00 pm" is contradictory — whatever we do, it must stay in-range.
  const contradictory = parseShotgunTime('13:00 pm');
  ok(contradictory === null || (contradictory.hour >= 0 && contradictory.hour <= 23), 'contradictory meridiem stays in range');

  const tl = buildPrepTimeline(18, 'garbage-date', ['x']);
  ok(tl.every((s) => s.at === null), 'a garbage shotgun instant yields null clock times, not Invalid Date');

  section('5. Ask generation never fabricates');
  const zeroPlan = calculateFb({ playerCount: 0, temperatureF: 78 });
  for (const c of VENDOR_CATEGORIES) {
    const askZero = askFor(c.key, zeroPlan);
    ok(askZero === null, `${c.label}: a zero-player plan produces no ask at all`, askZero ?? 'null');
  }

  // ── Database stress ───────────────────────────────────────────────────────
  const { error: schemaErr } = await db.from('fb_calculations').select('quantities').limit(1);
  if (schemaErr) { console.log('\n❌ migration 041 missing — DB half skipped'); process.exit(1); }

  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${Date.now()}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE`, city: 'Monterey', state: 'CA', zip: '93940', total_holes: 18, par_total: 72,
  }).select('id').single();
  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: owner!.user!.id, course_id: course!.id,
    event_date: '2026-10-10', shotgun_time: '8:00 AM', format: 'scramble',
    max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select('id').single();
  const tid = t!.id as string;

  const cleanup = async () => {
    const { data: ps } = await db.from('donation_prospects').select('id').eq('tournament_id', tid);
    for (const p of ps ?? []) await db.from('donation_outreach_log').delete().eq('prospect_id', p.id);
    await db.from('donation_prospects').delete().eq('tournament_id', tid);
    await db.from('fb_calculations').delete().eq('tournament_id', tid);
    await db.from('registrations').delete().eq('tournament_id', tid);
    await db.from('tournaments').delete().eq('id', tid);
    await db.from('courses').delete().eq('id', course!.id);
    await db.auth.admin.deleteUser(owner!.user!.id);
  };

  try {
    section('6. Concurrent sends race for one claim');
    const { data: p1 } = await db.from('donation_prospects').insert({
      tournament_id: tid, name: 'Race Target', company: 'Race Target', category: 'beer_wine_distributor',
      email: `race@${DOM}`, status: 'prospect',
    }).select('id').single();
    const pid = p1!.id as string;

    // Both provide subject+body so neither needs the AI; both race for
    // follow_up_number 0. Exactly one may claim it.
    const results = await Promise.all([
      sendDonationOutreach(db, tid, pid, { subject: 'A', body: 'first copy' }),
      sendDonationOutreach(db, tid, pid, { subject: 'B', body: 'second copy' }),
    ]);
    const { data: logs0 } = await db.from('donation_outreach_log')
      .select('id, outcome').eq('prospect_id', pid).eq('direction', 'outbound').eq('follow_up_number', 0);
    ok((logs0 ?? []).length === 1, 'two simultaneous sends produce exactly ONE outbound attempt row', `${(logs0 ?? []).length} rows`);
    const oks = results.filter((r) => r.ok).length;
    ok(oks <= 1, 'at most one of the racers reports success', `${oks} ok`);

    // Whatever happened, the vendor's follow_up_count is coherent.
    const { data: after } = await db.from('donation_prospects').select('follow_up_count, status').eq('id', pid).single();
    ok((after!.follow_up_count as number) === 0, 'first-touch does not increment the follow-up counter', String(after!.follow_up_count));

    section('7. The cadence cannot exceed the cap even when rows lie');
    // Adversarial row: chaseable status but counter already AT the cap.
    await db.from('donation_prospects').update({
      status: 'opened', follow_up_count: MAX_FOLLOWUPS, last_contact_at: daysAgo(30),
    }).eq('id', pid);
    const run = await runDonationFollowups(db);
    ok(!run.details.some((d) => d.prospectId === pid), 'a row at the cap is never picked up again');

    // Counter corrupted above the cap — still never chased.
    await db.from('donation_prospects').update({ follow_up_count: 99 }).eq('id', pid);
    const run2 = await runDonationFollowups(db);
    ok(!run2.details.some((d) => d.prospectId === pid), 'a corrupted counter above the cap is still excluded');

    section('8. Scale: 120 prospects load and summarise correctly');
    const bulk = Array.from({ length: 120 }, (_, i) => ({
      tournament_id: tid,
      name: `Bulk ${i}`, company: `Bulk Vendor ${i}`,
      category: VENDOR_CATEGORIES[i % VENDOR_CATEGORIES.length].key,
      email: `bulk${i}@${DOM}`,
      status: (['prospect', 'sent', 'opened', 'responded', 'committed', 'declined'] as const)[i % 6],
      committed_value_cents: i % 6 === 4 ? 10_000 : null,
      last_contact_at: i % 6 === 1 || i % 6 === 2 ? daysAgo(10) : null,
    }));
    const { error: bulkErr } = await db.from('donation_prospects').insert(bulk);
    ok(!bulkErr, '120 prospects insert cleanly', bulkErr?.message ?? '');

    const t0 = Date.now();
    const snap = await loadDonations(db, tid);
    const ms = Date.now() - t0;
    ok(snap.prospects.length === 121, 'all 121 come back', String(snap.prospects.length));
    ok(snap.summary.committed === 20 && snap.summary.committedValueCents === 200_000,
      'the funnel summary is exact at scale', `${snap.summary.committed} committed, $${snap.summary.committedValueCents / 100}`);
    ok(snap.donorWall.total === 20, 'the donor wall carries exactly the committed twenty');
    ok(ms < 5000, 'snapshot under 5s', `${ms}ms`);

    section('9. F&B plan write/read cycle under weird-but-legal input');
    await saveFbInputs(db, tid, {
      temperature_f: 110.4, precip_chance: 0, weather_source: 'manual',
      volunteer_count: 0, guest_count: 4999, holes: 9,
      assumptions: { beer: 0, water: 12.75, soft_drinks: 0.25, sports_drinks: 0, snacks: 50 },
      menu: [EMOJI],
    });
    const plan = (await loadFbPlan(db, tid))!;
    ok(plan.plan !== null, 'an extreme-but-legal plan computes');
    ok(plan.plan!.lines.find((l) => l.key === 'beer')!.units === 0, 'a zero beer baseline yields zero beer, not a default');
    ok(plan.baselines.water === 12.75, 'fractional baselines round-trip exactly');
    ok(plan.menu[0] === EMOJI, 'unicode menu items round-trip');
    ok(plan.shotgunAt === '2026-10-10T08:00:00.000Z', '"8:00 AM" free-text shotgun time parses on the stored tournament');

    section('10. Cross-tenant containment');
    // A prospect id from this tournament, presented with a DIFFERENT tournament id.
    const foreign = await sendDonationOutreach(db, '00000000-0000-0000-0000-000000000000', pid, { subject: 'x', body: 'y' });
    ok(!foreign.ok, 'a prospect cannot be sent through another tournament id');
    const wrongPlan = await loadFbPlan(db, '00000000-0000-0000-0000-000000000000');
    ok(wrongPlan === null, 'a nonexistent tournament yields null, not an empty plan');
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  section('11. pluralUnit');
  ok(pluralUnit('case', 1) === 'case' && pluralUnit('case', 2) === 'cases', 'case/cases');
  ok(pluralUnit('box', 2) === 'boxes' && pluralUnit('12-pack', 3) === '12-packs', 'boxes and 12-packs');

  console.log(failures === 0
    ? '\n✅ FB + DONATIONS STRESS — ALL CHECKS PASSED'
    : `\n❌ FB + DONATIONS STRESS — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); process.exit(1); });
