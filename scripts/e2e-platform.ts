// DAY 31 — the whole platform, one tournament, start to finish.
//
// Every other suite proves one phase. This one is the spec's own walkthrough:
// an organizer signs up, creates a tournament, builds a team, sells
// sponsorships, accepts registrations, runs tournament day, and closes out —
// with each step asserting against what the PREVIOUS step actually wrote.
//
// It runs against the deployed API by default (E2E_BASE_URL), because half of
// what can break here lives in route handlers and auth, not in libraries.
//
//   npx tsx scripts/e2e-platform.ts
//   E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/e2e-platform.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadTeam } from '../lib/toc/team';
import { loadFbPlan, saveFbInputs } from '../lib/fb/plan';
import { loadDonations } from '../lib/donations/outreach';
import { loadProfile } from '../lib/guidance/profile';
import { runCadence } from '../lib/comm/runCadence';
import { fireTrigger } from '../lib/dayof/triggers';
import { buildGoals } from '../lib/toc/phase';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const SUPA = get('NEXT_PUBLIC_SUPABASE_URL')!;
const ANON = get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!;
const db = createClient(SUPA, get('SUPABASE_SERVICE_ROLE_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const RUN = Date.now().toString(36);
const TAG = 'ZZZ PLATFORM';
const DOM = `${RUN}.platform.example.invalid`;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
};

async function main() {
  console.log(`Base: ${BASE}`);

  // ── 1. Organizer signs up ────────────────────────────────────────────────
  section('1. Organizer signs up and gets a session');
  const email = `organizer-${RUN}@${DOM}`;
  const password = `zzzAa1!${Math.random().toString(36).slice(2)}`;
  const { data: created } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  ok(!!created?.user, 'account created');
  const pub = createClient(SUPA, ANON);
  const { data: session } = await pub.auth.signInWithPassword({ email, password });
  const jwt = session.session?.access_token;
  ok(!!jwt, 'organizer can sign in and holds a JWT');
  const bearer = { Authorization: `Bearer ${jwt}` };
  const organizerId = created!.user!.id;

  // A second organizer, to prove tenancy at every step.
  const rivalEmail = `rival-${RUN}@${DOM}`;
  const { data: rival } = await db.auth.admin.createUser({ email: rivalEmail, password, email_confirm: true });
  const { data: rivalSess } = await createClient(SUPA, ANON).auth.signInWithPassword({ email: rivalEmail, password });
  const rivalBearer = { Authorization: `Bearer ${rivalSess.session!.access_token}` };

  // ── 2. Creates a tournament ──────────────────────────────────────────────
  section('2. Creates a tournament');
  const soon = new Date(Date.now() + 20 * 3_600_000);
  const eventDate = soon.toISOString().slice(0, 10);
  const { data: course } = await db.from('courses').insert({
    name: `${TAG} COURSE`, city: 'Monterey', state: 'CA', zip: '93940',
    total_holes: 18, par_total: 72, contact_email: `kitchen@${DOM}`,
  }).select('id').single();

  const createRes = await api('/api/tournaments', {
    method: 'POST', headers: bearer,
    body: JSON.stringify({
      name: `${TAG} CUP`, event_date: eventDate, course_id: course!.id,
      format: 'scramble', max_players: 8, entry_fee_cents: 16500,
      shotgun_time: '8:30 AM',
    }),
  });
  ok(createRes.status === 200 || createRes.status === 201,
    'tournament created through the API', `HTTP ${createRes.status}`);
  const tid = ((createRes.data.tournament as { id?: string })?.id
    ?? (createRes.data as { id?: string }).id) as string;
  ok(!!tid, 'and returns its id');
  if (!tid) { console.log('   cannot continue without a tournament id'); process.exit(1); }

  const cleanup = async () => {
    for (const tbl of ['guidance_events', 'volunteer_task_completions', 'volunteer_messages',
      'volunteer_guidance_profiles', 'push_subscriptions', 'tournament_events', 'communication_log',
      'donation_prospects', 'fb_calculations', 'tournament_volunteer_assignments', 'volunteers',
      'planning_meetings', 'meeting_action_items', 'sponsors', 'registrations', 'tournament_goals']) {
      await db.from(tbl).delete().eq('tournament_id', tid).then(() => {}, () => {});
    }
    await db.from('tournaments').delete().eq('id', tid);
    await db.from('courses').delete().eq('id', course!.id);
    await db.auth.admin.deleteUser(organizerId);
    await db.auth.admin.deleteUser(rival!.user!.id);
  };

  try {
    // Tenancy from the very first read.
    const crossRead = await api(`/api/tournament/${tid}/team`, { headers: rivalBearer });
    ok(crossRead.status === 403, 'a rival organizer is refused from the outset', `HTTP ${crossRead.status}`);

    // ── 3. Builds a team ───────────────────────────────────────────────────
    section('3. Builds the team');
    const { data: roles } = await db.from('role_templates').select('id, name, phase');
    const regLeadRole = roles!.find((r) => r.name === 'Registration Lead')!;
    const kitchenRole = roles!.find((r) => r.name === 'Kitchen Liaison')!;
    const chairRole = roles!.find((r) => r.name === 'Sponsorship Committee Chair')!;

    const assign = async (roleId: string, name: string, phone: string | null) => {
      const r = await api(`/api/tournament/${tid}/team`, {
        method: 'POST', headers: bearer,
        body: JSON.stringify({
          roleTemplateId: roleId, name,
          email: `${name.replace(/\W/g, '').toLowerCase()}@${DOM}`,
          phone, invite: false,
        }),
      });
      return r;
    };
    const a1 = await assign(regLeadRole.id, `${TAG} Dana`, '9855550134');
    ok(a1.status === 200, 'Registration Lead assigned', `HTTP ${a1.status}`);
    await assign(kitchenRole.id, `${TAG} Ana`, null);
    await assign(chairRole.id, `${TAG} Chris`, null);

    const team = await loadTeam(db, tid);
    const filled = team!.roles.filter((r) => r.members.length > 0);
    ok(filled.length === 3, 'three roles filled', filled.map((r) => r.name).join(', '));
    ok(team!.summary.dayOfFilled === 2 && team!.summary.planningFilled === 1,
      'and they land in the right phases', `day-of ${team!.summary.dayOfFilled}, planning ${team!.summary.planningFilled}`);

    const danaMember = filled.flatMap((r) => r.members).find((m) => m.name.includes('Dana'))!;
    ok(!!danaMember.inviteUrl, 'every member carries a shareable link even with invite:false');

    // The volunteer confirms via their own token — no account.
    const confirmRes = await api('/api/volunteer/respond', {
      method: 'POST',
      body: JSON.stringify({ token: danaMember.inviteUrl!.split('/v/')[1], answer: 'confirm' }),
    });
    ok(confirmRes.status === 200, 'the volunteer confirms with only their token', `HTTP ${confirmRes.status}`);

    // ── 4. Sells sponsorships ──────────────────────────────────────────────
    section('4. Sells sponsorships');
    const { error: sErr } = await db.from('sponsors').insert([
      { tournament_id: tid, company: `${TAG} Bank`, status: 'paid', amount_cents: 250_000, email: `bank@${DOM}` },
      { tournament_id: tid, company: `${TAG} Realty`, status: 'verbal', amount_cents: 100_000, email: `realty@${DOM}` },
      { tournament_id: tid, company: `${TAG} Declined Co`, status: 'declined', amount_cents: 500_000, email: `no@${DOM}` },
    ]);
    ok(!sErr, 'three sponsors recorded', sErr?.message ?? '');

    const goalsRes = await api(`/api/tournament/${tid}/toc`, { headers: bearer });
    ok(goalsRes.status === 200, 'the goals dashboard loads', `HTTP ${goalsRes.status}`);
    const goals = goalsRes.data as { goals?: { key: string; actual: number }[] };
    const sponsorGoal = goals.goals?.find((g) => g.key === 'sponsorship');
    ok(sponsorGoal?.actual === 350_000,
      'INTEGRATION: committed sponsorship counts paid + verbal and EXCLUDES declined',
      `$${(sponsorGoal?.actual ?? 0) / 100}`);

    // ── 5. Accepts registrations ───────────────────────────────────────────
    section('5. Accepts registrations — including the capacity edge');

    const register = (n: number) => api('/api/registrations', {
      method: 'POST',
      body: JSON.stringify({
        tournament_id: tid, registration_type: 'foursome',
        contact_name: `${TAG} Captain ${n}`, contact_email: `cap${n}-${RUN}@${DOM}`,
        players: Array.from({ length: 4 }, (_, i) => ({ name: `${TAG} P${n}-${i}` })),
      }),
    });

    // Publishing is the gate, not a formality. A draft tournament must refuse
    // public registrations outright — its date and price are still being
    // edited, and a stranger holding the id would otherwise be charged for an
    // event that has not been announced.
    const beforePublish = await register(0);
    ok(beforePublish.status === 409,
      'a DRAFT tournament refuses a public registration', `HTTP ${beforePublish.status}`);
    await db.from('tournaments').update({ status: 'published' }).eq('id', tid);

    const r1 = await register(1);
    ok(r1.status === 200 || r1.status === 201, 'first foursome registers', `HTTP ${r1.status}`);
    const r2 = await register(2);
    ok(r2.status === 200 || r2.status === 201, 'second foursome fills the 8-player field', `HTTP ${r2.status}`);
    const r3 = await register(3);
    ok(r3.status === 409, 'CAPACITY: the ninth player is refused with 409, not silently accepted',
      `HTTP ${r3.status} ${String((r3.data as { error?: string }).error ?? '')}`);

    // PRICE: what the card is billed comes from THIS tournament's entry fee,
    // computed server-side. It used to come from a module-level constant, so
    // every tournament on the platform charged $600 a foursome no matter what
    // its organizer set. Entry fee here is $165, so a foursome is 4 x 165 =
    // $660, plus the 2.5% new-member fee = $676.50.
    const { data: priced } = await db.from('registrations')
      .select('total_amount_cents, platform_fee_cents')
      .eq('tournament_id', tid).limit(1).maybeSingle();
    ok(priced?.total_amount_cents === 67_650,
      'PRICE: a foursome is billed 4x the entry fee the organizer set, plus the platform fee',
      `$${((priced?.total_amount_cents ?? 0) / 100).toFixed(2)} (fee $${((priced?.platform_fee_cents ?? 0) / 100).toFixed(2)})`);

    const { data: regs } = await db.from('registrations').select('id, payment_status, starting_hole, foursome_number')
      .eq('tournament_id', tid);
    ok((regs ?? []).length === 2, 'exactly two registrations exist', `${regs?.length}`);
    ok(new Set((regs ?? []).map((r) => r.foursome_number)).size === 2,
      'and they were given distinct foursome numbers by the atomic insert');

    // Money: the goals dashboard must agree with the field.
    const goals2 = (await api(`/api/tournament/${tid}/toc`, { headers: bearer })).data as { goals?: { key: string; actual: number }[] };
    ok(goals2.goals?.find((g) => g.key === 'players')?.actual === 8,
      'INTEGRATION: 2 foursomes = 8 players on the goals dashboard');

    // ── 6. F&B plan → donation ask ─────────────────────────────────────────
    section('6. Plans food and drink, and turns it into a vendor ask');
    await saveFbInputs(db, tid, {
      temperature_f: 78, weather_source: 'manual', volunteer_count: 3,
      weather_summary: 'Entered by hand: 78°F.', weather_fetched_at: new Date().toISOString(),
    });
    const plan = await loadFbPlan(db, tid);
    ok(plan?.plan?.inputs.playerCount === 8, 'the F&B plan uses the real headcount', String(plan?.livePlayerCount));
    await db.from('donation_prospects').insert({
      tournament_id: tid, name: 'Coast Beverage', company: 'Coast Beverage',
      category: 'beer_wine_distributor', email: `beer@${DOM}`, status: 'prospect',
    });
    const donations = await loadDonations(db, tid);
    const beerAsk = donations.asks.find((a) => a.key === 'beer_wine_distributor')!.ask!;
    const beerPacks = plan!.plan!.lines.find((l) => l.key === 'beer')!.packs;
    ok(beerAsk.includes(`${beerPacks} case`) && beerAsk.includes('8 players'),
      'INTEGRATION: the calculated quantity is the exact vendor ask', beerAsk);

    // ── 7. Guidance + reminders ────────────────────────────────────────────
    section('7. Guidance picks the channel the reminder uses');
    const danaProfile = await loadProfile(db, tid, danaMember.volunteerId);
    ok(danaProfile.experienceLevel === 'first_timer' && danaProfile.depth === 'detailed',
      'a first-time volunteer gets full detail', `${danaProfile.experienceLevel}/${danaProfile.depth}`);
    const cadence = await runCadence(db, new Date(), tid);
    const mine = cadence.details.filter((d) => d.volunteerId === danaMember.volunteerId);
    ok(mine.length === 1, 'exactly one reminder is due 20 hours out', `${mine.length}`);
    ok(mine[0]?.offsetKey === 'pre_event:1440', 'and it is the 24-hour slot', mine[0]?.offsetKey);

    // ── 8. Tournament day ──────────────────────────────────────────────────
    section('8. Tournament day');
    const shotgun = await fireTrigger(db, tid, 'shotgun_started');
    ok(shotgun.ok, 'shotgun fires');
    ok(shotgun.notified === 1, 'and reaches the one CONFIRMED day-of volunteer',
      `${shotgun.notified} notified`);

    const dayofRes = await api(`/api/tournament/${tid}/dayof`, { headers: bearer });
    ok(dayofRes.status === 200, 'the day-of board loads', `HTTP ${dayofRes.status}`);
    const board = dayofRes.data as { summary?: { expected: number; checkedIn: number }; triggers?: { kind: string; firedAt: string | null }[] };
    ok(board.triggers?.find((t) => t.kind === 'shotgun_started')?.firedAt != null,
      'and shows the shotgun as sent');

    const checkIn = await api(`/api/tournament/${tid}/dayof`, {
      method: 'POST', headers: bearer,
      body: JSON.stringify({ action: 'check_in', volunteerId: danaMember.volunteerId }),
    });
    ok(checkIn.status === 200, 'the organizer checks a volunteer in');
    const board2 = checkIn.data as { summary?: { checkedIn: number } };
    ok(board2.summary?.checkedIn === 1, 'and the board reflects it immediately', `${board2.summary?.checkedIn}`);

    const rivalDayof = await api(`/api/tournament/${tid}/dayof`, { headers: rivalBearer });
    ok(rivalDayof.status === 403, 'TENANCY: the rival cannot see the day-of board');

    // Leaderboard is public by design (clubhouse TV) — but must not 500.
    const boardPublic = await api(`/api/tournament/${tid}/board`);
    ok(boardPublic.status === 200, 'the public leaderboard renders for the clubhouse TV',
      `HTTP ${boardPublic.status}`);

    // ── 9. Post-tournament ─────────────────────────────────────────────────
    section('9. Post-tournament');
    const complete = await fireTrigger(db, tid, 'tournament_complete');
    ok(complete.ok, 'the tournament closes out');

    const finalGoals = (await api(`/api/tournament/${tid}/toc`, { headers: bearer })).data as {
      goals?: { key: string; actual: number; target: number }[];
    };
    ok((finalGoals.goals ?? []).length >= 5, 'the five goals report at the end', `${finalGoals.goals?.length}`);
    const derived = buildGoals(null, {
      players: 8, sponsorshipCents: 350_000, donationItems: 1, marketingReach: 0, rolesFilled: 3,
    });
    ok(derived.length >= 5, 'and buildGoals derives the same five shape without a stored row');

    // The whole point of the platform: none of this leaked sideways.
    section('10. Nothing leaked sideways');
    const rivalProbes = await Promise.all([
      api(`/api/tournament/${tid}/toc`, { headers: rivalBearer }),
      api(`/api/tournament/${tid}/fb`, { headers: rivalBearer }),
      api(`/api/tournament/${tid}/donations`, { headers: rivalBearer }),
      api(`/api/tournament/${tid}/comm`, { headers: rivalBearer }),
      api(`/api/registrations?tournament_id=${tid}`, { headers: rivalBearer }),
    ]);
    ok(rivalProbes.every((p) => p.status === 403),
      'every organizer-scoped surface refuses the rival with 403',
      rivalProbes.map((p) => p.status).join(','));

    const anonProbes = await Promise.all([
      api(`/api/tournament/${tid}/toc`),
      api(`/api/tournament/${tid}/dayof`),
      api(`/api/registrations?tournament_id=${tid}`),
    ]);
    ok(anonProbes.every((p) => p.status === 401),
      'and refuses anonymous callers with 401', anonProbes.map((p) => p.status).join(','));
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(failures === 0
    ? '\n✅ FULL PLATFORM E2E — ALL CHECKS PASSED'
    : `\n❌ FULL PLATFORM E2E — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
