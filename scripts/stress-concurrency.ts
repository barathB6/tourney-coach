// DAY 31 — what happens when everything arrives at once.
//
// Every idempotency guard in this platform is a claim-before-act: insert a row
// protected by a unique index, THEN do the irreversible thing. That design is
// only worth anything if the race it defends against actually loses. So this
// suite doesn't send requests in sequence and hope — it fires them
// simultaneously and asserts on exactly-once.
//
// The five races that matter, and what a failure costs:
//
//   capacity        two foursomes for the last four seats → an oversold field
//   reminders       two cadence runs at once             → duplicate SMS to a volunteer
//   triggers        two "shotgun started" taps           → duplicate day-of blast
//   donations       cron + manual "Send now"             → two asks to one vendor
//   access codes    a volunteer mashing "send me a code" → the brute-force window widens
//
//   npx tsx scripts/stress-concurrency.ts
//   E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/stress-concurrency.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { runCadence } from '../lib/comm/runCadence';
import { fireTrigger } from '../lib/dayof/triggers';
import { issueCode, verifyCode, hashContact, MAX_REQUESTS_PER_HOUR } from '../lib/volunteer/accessCode';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const RUN = Date.now().toString(36);
const TAG = 'ZZZ STRESS';
const DOM = `${RUN}.stress.example.invalid`;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
};

async function main() {
  console.log(`Base: ${BASE}`);

  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-stress-${RUN}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const ownerId = owner!.user!.id;

  // Tomorrow — inside the cadence window, so reminders are genuinely due.
  const eventDate = new Date(Date.now() + 20 * 3_600_000).toISOString().slice(0, 10);
  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} CUP ${RUN}`, organizer_id: ownerId, event_date: eventDate,
    shotgun_time: '8:30 AM', format: 'scramble', max_players: 8,
    entry_fee_cents: 16500, status: 'published',
  }).select('id').single();
  const tid = t!.id as string;

  const { data: roles } = await db.from('role_templates').select('id, name, phase');
  const dayOfRole = roles!.find((r) => r.phase === 'day_of')!;

  const volunteers: { id: string; email: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const email = `vol${i}-${RUN}@${DOM}`;
    const { data: v } = await db.from('volunteers')
      .insert({ tournament_id: tid, name: `${TAG} Vol ${i}`, email }).select('id').single();
    await db.from('tournament_volunteer_assignments').insert({
      tournament_id: tid, volunteer_id: v!.id, role_template_id: dayOfRole.id,
      status: 'confirmed', invite_token: crypto.randomUUID(),
    });
    volunteers.push({ id: v!.id as string, email });
  }

  const { data: prospect } = await db.from('donation_prospects').insert({
    tournament_id: tid, name: 'Coast Beverage', company: 'Coast Beverage',
    category: 'beer_wine_distributor', email: `vendor-${RUN}@${DOM}`, status: 'prospect',
  }).select('id').single();

  const cleanup = async () => {
    await db.from('volunteer_access_codes').delete()
      .in('contact_hash', volunteers.map((v) => hashContact(v.email)));
    for (const tbl of ['guidance_events', 'volunteer_task_completions', 'volunteer_messages',
      'volunteer_guidance_profiles', 'push_subscriptions', 'tournament_events', 'communication_log',
      'donation_outreach_log', 'donation_prospects', 'fb_calculations',
      'tournament_volunteer_assignments', 'volunteers', 'registrations', 'tournament_goals']) {
      await db.from(tbl).delete().eq('tournament_id', tid).then(() => {}, () => {});
    }
    await db.from('tournaments').delete().eq('id', tid);
    await db.auth.admin.deleteUser(ownerId);
  };

  try {
    // ── 1. Capacity under simultaneous load ──────────────────────────────────
    section('1. Eight seats, twelve foursomes, all at once');
    // 12 concurrent foursomes against a 8-player field. Exactly two may win.
    // The check, the foursome numbering and the insert all live inside
    // create_registration_atomic (migration 011) precisely so this cannot be
    // read-then-write from app code.
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, n) =>
      api('/api/registrations', {
        method: 'POST',
        body: JSON.stringify({
          tournament_id: tid, registration_type: 'foursome',
          contact_name: `${TAG} Cap ${n}`, contact_email: `cap${n}-${RUN}@${DOM}`,
          players: Array.from({ length: 4 }, (_, i) => ({ name: `${TAG} P${n}-${i}` })),
        }),
      })));
    const accepted = attempts.filter((a) => a.status === 200 || a.status === 201).length;
    const refused = attempts.filter((a) => a.status === 409).length;
    ok(accepted === 2, 'EXACTLY two foursomes are accepted — the field is not oversold',
      `${accepted} accepted, ${refused} refused with 409`);
    ok(accepted + refused === 12, 'and nobody got a 500 — a full field is a 409, not a crash',
      attempts.map((a) => a.status).join(','));

    const { data: regs } = await db.from('registrations')
      .select('foursome_number, starting_hole').eq('tournament_id', tid);
    ok((regs ?? []).length === 2, 'exactly two rows landed', `${regs?.length}`);
    const nums = (regs ?? []).map((r) => r.foursome_number);
    ok(new Set(nums).size === nums.length,
      'FOURSOME NUMBERS ARE UNIQUE — two teams cannot share a slot', nums.join(','));

    // ── 2. Two cadence runs at the same instant ──────────────────────────────
    section('2. Two reminder runs racing');
    // A daily cron plus an organizer hitting "Send due reminders now" is the
    // real version of this. The claim row goes in first, guarded by a partial
    // unique index on (volunteer_id, offset_key) — the loser gets 23505 and
    // must not send.
    const [runA, runB] = await Promise.all([
      runCadence(db, new Date(), tid),
      runCadence(db, new Date(), tid),
    ]);
    const sent = runA.sent + runB.sent;
    const claimed = runA.alreadyClaimed + runB.alreadyClaimed;
    ok(sent === volunteers.length,
      `each of the ${volunteers.length} volunteers is reminded exactly once across both runs`,
      `${sent} sent, ${claimed} refused as already-claimed`);

    const { data: ledger } = await db.from('communication_log')
      .select('volunteer_id, offset_key, channel').eq('tournament_id', tid)
      .eq('kind', 'reminder').neq('channel', 'in_app');
    const slots = (ledger ?? []).map((r) => `${r.volunteer_id}:${r.offset_key}`);
    ok(new Set(slots).size === slots.length,
      'THE LEDGER HAS NO DUPLICATE SLOT — nobody was texted twice', `${slots.length} rows`);

    // ── 3. Two organizers tapping the same day-of trigger ────────────────────
    section('3. The shotgun trigger, tapped five times at once');
    // tournament_events is unique on (tournament_id, kind). Five taps, one blast.
    const fires = await Promise.all(Array.from({ length: 5 }, () =>
      fireTrigger(db, tid, 'shotgun_started')));
    const fired = fires.filter((f) => f.ok).length;
    ok(fired === 1, 'exactly one fire wins; the other four are refused',
      `${fired} of 5 fired`);
    const { count: eventRows } = await db.from('tournament_events')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tid).eq('kind', 'shotgun_started');
    ok(eventRows === 1, 'and one event row exists, not five', `${eventRows}`);

    const { data: blasts } = await db.from('communication_log')
      .select('volunteer_id').eq('tournament_id', tid).eq('kind', 'day_of').neq('channel', 'in_app');
    const perVolunteer = new Map<string, number>();
    for (const b of blasts ?? []) perVolunteer.set(b.volunteer_id as string, (perVolunteer.get(b.volunteer_id as string) ?? 0) + 1);
    ok([...perVolunteer.values()].every((n) => n === 1),
      'NO VOLUNTEER GOT THE HORN TWICE', [...perVolunteer.values()].join(','));

    // ── 4. The donation cron racing a manual send ────────────────────────────
    section('4. A vendor ask sent from two places at once');
    // follow_up_number used to be read off the prospect's mutable
    // follow_up_count, so two racers computed different slots and both cleared
    // the unique index. It is derived from the outreach log now — the same
    // table the index protects.
    const { sendDonationOutreach } = await import('../lib/donations/outreach');
    const both = await Promise.all([
      sendDonationOutreach(db, tid, prospect!.id as string, { subject: 'Ask', body: 'Body' }),
      sendDonationOutreach(db, tid, prospect!.id as string, { subject: 'Ask', body: 'Body' }),
    ]);
    const wins = both.filter((r) => r.ok).length;
    const { data: outbound } = await db.from('donation_outreach_log')
      .select('id, follow_up_number').eq('prospect_id', prospect!.id as string).eq('direction', 'outbound');
    ok((outbound ?? []).length === 1,
      'ONE ask reaches the vendor, not two', `${wins} call(s) reported ok, ${outbound?.length} log row(s)`);

    // ── 5. A volunteer mashing "send me a code" ──────────────────────────────
    section('5. Ten simultaneous access-code requests for one contact');
    // The per-hour cap is what stops an attacker widening the guessing window
    // by reissuing. Racing it must not mint more than the cap.
    const contact = volunteers[0].email;
    const issued = await Promise.all(Array.from({ length: 10 }, () => issueCode(db, contact)));
    const minted = issued.filter((r) => r.ok).length;
    const limited = issued.filter((r) => r.rateLimited).length;
    ok(minted <= MAX_REQUESTS_PER_HOUR,
      `no more than ${MAX_REQUESTS_PER_HOUR} codes are minted even racing`,
      `${minted} minted, ${limited} rate limited`);
    const { count: codeRows } = await db.from('volunteer_access_codes')
      .select('id', { count: 'exact', head: true }).eq('contact_hash', hashContact(contact));
    ok((codeRows ?? 0) <= MAX_REQUESTS_PER_HOUR,
      'and the table agrees — the cap is not a client-side illusion', `${codeRows} rows`);

    section('5b. Five simultaneous wrong guesses against one code');
    // The attempt counter is the thing standing between a six-digit code and
    // an attacker. Read-then-write meant five parallel guesses all read
    // attempts = 0 and all wrote 1 — five guesses for the price of one, and a
    // code that never dies.
    const guessContact = `guess-${RUN}@${DOM}`;
    await db.from('volunteers')
      .insert({ tournament_id: tid, name: `${TAG} Guess`, email: guessContact });
    const fresh = await issueCode(db, guessContact);
    if (fresh.ok) {
      await Promise.all(Array.from({ length: 5 }, (_, i) =>
        verifyCode(db, guessContact, String(100000 + i))));
      const { data: after } = await db.from('volunteer_access_codes')
        .select('attempts').eq('contact_hash', hashContact(guessContact))
        .order('created_at', { ascending: false }).limit(1);
      ok((after?.[0]?.attempts ?? 0) === 5,
        'ALL FIVE ATTEMPTS ARE COUNTED — parallel guessing is not free',
        `attempts recorded: ${after?.[0]?.attempts}`);
      const stillAlive = await verifyCode(db, guessContact, fresh.code!);
      ok(!stillAlive.ok,
        'and the correct code is dead afterwards — guessing cannot be outlasted by racing',
        stillAlive.ok ? 'accepted!' : stillAlive.reason);
      await db.from('volunteer_access_codes').delete().eq('contact_hash', hashContact(guessContact));
    }

    // ── 6. The goals dashboard under concurrent reads ────────────────────────
    section('6. Twenty concurrent reads of the derived dashboard');
    // Everything on it is recomputed per request. Twenty simultaneous reads
    // must agree — if they don't, something is being cached or mutated on read.
    const { data: sess } = await createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!)
      .auth.signInWithPassword({ email: `zzz-stress-${RUN}@${DOM}`, password: 'unused' })
      .catch(() => ({ data: { session: null } }));
    if (!sess?.session) {
      // Signing in needs the password we generated above; read through the
      // library instead, which is the same code path the route runs.
      const { loadOperationsCenter } = await import('../lib/toc/load');
      const reads = await Promise.all(Array.from({ length: 20 }, () => loadOperationsCenter(db, tid)));
      const shapes = new Set(reads.map((r) => JSON.stringify((r?.goals ?? []).map((g) => [g.key, g.actual]))));
      ok(shapes.size === 1, 'all twenty reads return identical goal actuals', `${shapes.size} distinct result(s)`);
      const players = reads[0]?.goals?.find((g) => g.key === 'players')?.actual;
      ok(players === 8, 'and the number is the truth: 2 foursomes = 8 players', `${players}`);
    }
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(failures === 0
    ? '\n✅ CONCURRENCY — ALL CHECKS PASSED'
    : `\n❌ CONCURRENCY — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
