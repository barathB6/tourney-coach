// DAY 32 — measured latency for the paths a real tournament actually waits on.
//
// "Performance meets targets" means nothing without the targets written down
// and the numbers measured, so both are here. The budgets are set from what a
// person notices, not from what is easy to hit:
//
//   400ms   a page's own data load — under this it reads as instant
//   800ms   a dashboard that aggregates several tables
//   2000ms  a cron sweep over one tournament (nobody is watching, but a
//           Vercel function has a ceiling and a slow sweep hides a real one)
//
// Each path runs N times and reports median and worst. The worst case is the
// number that matters: the median hides the cold start an organizer hits when
// they open the dashboard once a week.
//
//   npx tsx scripts/perf-baseline.ts
//   E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/perf-baseline.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadOperationsCenter } from '../lib/toc/load';
import { loadTeam } from '../lib/toc/team';
import { loadFbPlan } from '../lib/fb/plan';
import { loadDonations } from '../lib/donations/outreach';
import { runCadence } from '../lib/comm/runCadence';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

const RUN = Date.now().toString(36);
const TAG = 'ZZZ PERF';
const DOM = `${RUN}.perf.example.invalid`;
const REPS = 5;

let overBudget = 0;
const rows: { path: string; median: number; worst: number; budget: number }[] = [];

async function time(path: string, budget: number, fn: () => Promise<unknown>) {
  // One untimed warmup. Against a dev server the first hit on a route includes
  // compiling it, which is a real 600ms that no user ever pays — measuring it
  // would make the number a lie in the flattering direction on production and
  // the alarming direction here.
  await fn().catch(() => {});
  const samples: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = Date.now();
    await fn();
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const worst = samples[samples.length - 1];
  rows.push({ path, median, worst, budget });
  const ok = worst <= budget;
  if (!ok) overBudget += 1;
  console.log(`  ${ok ? '✓' : '✗ OVER'} ${path.padEnd(42)} median ${String(median).padStart(5)}ms   worst ${String(worst).padStart(5)}ms   budget ${budget}ms`);
}

async function main() {
  console.log(`Base: ${BASE}  (${REPS} reps each)\n`);

  // A tournament with realistic volume: a full 72-player field, a committee,
  // a sponsor pipeline. Measuring against an empty tournament measures nothing.
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-perf-${RUN}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const ownerId = owner!.user!.id;
  const eventDate = new Date(Date.now() + 20 * 3_600_000).toISOString().slice(0, 10);
  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} CUP ${RUN}`, organizer_id: ownerId, event_date: eventDate,
    shotgun_time: '8:30 AM', format: 'scramble', max_players: 72,
    entry_fee_cents: 16500, status: 'published',
  }).select('id').single();
  const tid = t!.id as string;

  await db.from('registrations').insert(Array.from({ length: 18 }, (_, i) => ({
    tournament_id: tid, registration_type: 'foursome',
    contact_name: `${TAG} Cap ${i}`, contact_email: `cap${i}-${RUN}@${DOM}`,
    payment_status: i % 6 === 0 ? 'pending' : 'paid',
    total_amount_cents: 16500, foursome_number: i + 1,
    players: Array.from({ length: 4 }, (_, j) => ({ name: `${TAG} P${i}-${j}` })),
  })));
  await db.from('sponsors').insert(Array.from({ length: 12 }, (_, i) => ({
    tournament_id: tid, company: `${TAG} Co ${i}`, email: `co${i}-${RUN}@${DOM}`,
    amount_cents: 50_000 * (1 + (i % 4)),
    status: ['prospect', 'contacted', 'replied', 'verbal', 'paid', 'declined'][i % 6],
  })));

  const { data: roles } = await db.from('role_templates').select('id, phase');
  for (let i = 0; i < 10; i++) {
    const role = roles![i % roles!.length];
    const { data: v } = await db.from('volunteers')
      .insert({ tournament_id: tid, name: `${TAG} Vol ${i}`, email: `vol${i}-${RUN}@${DOM}` })
      .select('id').single();
    await db.from('tournament_volunteer_assignments').insert({
      tournament_id: tid, volunteer_id: v!.id, role_template_id: role.id,
      status: i % 4 === 0 ? 'assigned' : 'confirmed', invite_token: crypto.randomUUID(),
    });
  }
  await db.from('donation_prospects').insert(Array.from({ length: 15 }, (_, i) => ({
    tournament_id: tid, name: `${TAG} Vendor ${i}`, company: `${TAG} Vendor ${i}`,
    category: 'beer_wine_distributor', email: `v${i}-${RUN}@${DOM}`,
    status: ['prospect', 'sent', 'opened', 'responded', 'committed'][i % 5],
  })));

  const cleanup = async () => {
    for (const tbl of ['guidance_events', 'volunteer_task_completions', 'volunteer_messages',
      'volunteer_guidance_profiles', 'push_subscriptions', 'tournament_events', 'communication_log',
      'donation_outreach_log', 'donation_prospects', 'fb_calculations',
      'tournament_volunteer_assignments', 'volunteers', 'sponsors', 'registrations', 'tournament_goals']) {
      await db.from(tbl).delete().eq('tournament_id', tid).then(() => {}, () => {});
    }
    await db.from('tournaments').delete().eq('id', tid);
    await db.auth.admin.deleteUser(ownerId);
  };

  try {
    console.log('Library reads (what a page waits on):');
    await time('loadOperationsCenter (goals dashboard)', 800, () => loadOperationsCenter(db, tid));
    await time('loadTeam (volunteer command center)', 800, () => loadTeam(db, tid));
    await time('loadFbPlan (F&B planner)', 800, () => loadFbPlan(db, tid));
    await time('loadDonations (vendor pipeline)', 800, () => loadDonations(db, tid));

    console.log('\nPublic endpoints (a stranger on their phone):');
    await time('GET /api/tournaments/[id]/progress', 400,
      () => fetch(`${BASE}/api/tournaments/${tid}/progress`).then((r) => r.text()));
    await time('GET /api/tournament/[id]/board', 800,
      () => fetch(`${BASE}/api/tournament/${tid}/board`).then((r) => r.text()));
    await time('GET /api/sponsors/purchase', 400,
      () => fetch(`${BASE}/api/sponsors/purchase?tournament_id=${tid}`).then((r) => r.text()));
    await time('GET /api/health', 2000, () => fetch(`${BASE}/api/health`).then((r) => r.text()));

    console.log('\nCron sweeps (nobody watching, but a ceiling exists):');
    // Scoped to this tournament — the unscoped nightly sweep is measured by
    // how many tournaments are in the window, which is not a fixed number.
    await time('runCadence (one tournament)', 2000, () => runCadence(db, new Date(), tid));
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(`\n${'PATH'.padEnd(42)} ${'MEDIAN'.padStart(8)} ${'WORST'.padStart(8)} ${'BUDGET'.padStart(8)}`);
  for (const r of rows) {
    console.log(`${r.path.padEnd(42)} ${`${r.median}ms`.padStart(8)} ${`${r.worst}ms`.padStart(8)} ${`${r.budget}ms`.padStart(8)}`);
  }
  console.log(overBudget === 0
    ? '\n✅ PERFORMANCE — every path inside budget at worst case'
    : `\n❌ PERFORMANCE — ${overBudget} path(s) over budget`);
  process.exit(overBudget === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
