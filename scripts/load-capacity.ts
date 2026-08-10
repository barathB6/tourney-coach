// DAY 34 — can the platform take tournament-day traffic?
//
// Two different loads, because a golf tournament has two:
//
//   REGISTRATION SURGE — the hour a tournament opens, or the last seats before
//   it sells out: many people submitting the same foursome at once. The risk is
//   an oversold field or a 500. Enforced atomically (create_registration_atomic),
//   this fires 40 concurrent foursomes at a field with room for 3 and asserts
//   exactly 3 land, the rest 409, none 500.
//
//   READ STORM — tournament DAY: every player refreshing the live board, the
//   microsite polling "spots claimed", the clubhouse TV on a 20s loop. This is
//   almost all of the real load and it is all reads. This fires a burst of
//   concurrent GETs at the public endpoints and reports p50/p95/max and the
//   error rate, so "prepared for live traffic" is a measured claim, not a hope.
//
// Runs against a THROWAWAY tournament so it never touches the beta's roster.
//
//   E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/load-capacity.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const TAG = 'ZZZ LOAD';
const DOM = `${RUN}.load.example.invalid`;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const pct = (arr: number[], p: number) => arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

async function main() {
  console.log(`Base: ${BASE}\n`);
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-load-${RUN}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const ownerId = owner!.user!.id;
  const eventDate = new Date(Date.now() + 20 * 3_600_000).toISOString().slice(0, 10);
  // 12-player field = room for 3 foursomes.
  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} ${RUN}`, organizer_id: ownerId, event_date: eventDate, shotgun_time: '8:00 AM',
    format: 'scramble', max_players: 12, entry_fee_cents: 12500, status: 'published', slug: `zzz-load-${RUN}`,
  }).select('id, slug').single();
  const tid = t!.id as string;
  // Seed some registrations + sponsors so the board/microsite do real work.
  await db.from('registrations').insert(Array.from({ length: 2 }, (_, i) => ({
    tournament_id: tid, registration_type: 'foursome', contact_name: `${TAG} seed ${i}`,
    contact_email: `seed${i}-${RUN}@${DOM}`, payment_status: 'paid', total_amount_cents: 50000,
    foursome_number: i + 1, players: Array.from({ length: 4 }, (_, j) => ({ name: `P${i}-${j}` })),
  })));

  const cleanup = async () => {
    for (const tbl of ['registrations', 'sponsors', 'tournament_goals']) {
      await db.from(tbl).delete().eq('tournament_id', tid).then(() => {}, () => {});
    }
    await db.from('tournaments').delete().eq('id', tid);
    await db.auth.admin.deleteUser(ownerId);
  };

  try {
    // ── Registration surge ────────────────────────────────────────────────
    console.log('1. Registration surge — 40 foursomes at once, room for 1 more (8 seats left)');
    const t0 = Date.now();
    const attempts = await Promise.all(Array.from({ length: 40 }, (_, n) =>
      fetch(`${BASE}/api/registrations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament_id: tid, registration_type: 'foursome',
          contact_name: `${TAG} rush ${n}`, contact_email: `rush${n}-${RUN}@${DOM}`,
          players: Array.from({ length: 4 }, (_, i) => ({ name: `R${n}-${i}` })),
        }),
      }).then((r) => r.status).catch(() => 0)));
    const accepted = attempts.filter((s) => s === 200 || s === 201).length;
    const refused = attempts.filter((s) => s === 409).length;
    const errored = attempts.filter((s) => s >= 500 || s === 0).length;
    ok(accepted === 1, 'exactly one foursome takes the last 4 seats — field not oversold', `${accepted} accepted`);
    ok(errored === 0, 'NO 500s under the surge — a full field is a clean 409', `${errored} errored, ${refused} refused`);
    const { count: finalRegs } = await db.from('registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', tid);
    ok((finalRegs ?? 0) === 3, 'the field holds exactly its capacity in the database', `${finalRegs} foursomes = ${(finalRegs ?? 0) * 4} players / 12`);
    console.log(`    (surge settled in ${Date.now() - t0}ms)\n`);

    // ── Read storm ────────────────────────────────────────────────────────
    console.log('2. Read storm — the endpoints players hammer on tournament day');
    const endpoints = [
      { name: 'board (live leaderboard)', url: `/api/tournament/${tid}/board` },
      { name: 'progress (spots claimed)', url: `/api/tournaments/${tid}/progress` },
      { name: 'microsite (public page)', url: `/microsite/${t!.slug}` },
    ];
    for (const ep of endpoints) {
      const BURST = 60;
      const timings: number[] = [];
      let errs = 0;
      // Three waves of 20 concurrent, ~180 requests, to sustain rather than spike once.
      for (let wave = 0; wave < 3; wave++) {
        const batch = await Promise.all(Array.from({ length: BURST / 3 }, async () => {
          const s = Date.now();
          try { const r = await fetch(`${BASE}${ep.url}`); await r.text(); return { ms: Date.now() - s, ok: r.ok }; }
          catch { return { ms: Date.now() - s, ok: false }; }
        }));
        for (const b of batch) { timings.push(b.ms); if (!b.ok) errs += 1; }
      }
      const p50 = pct(timings, 0.5), p95 = pct(timings, 0.95), max = Math.max(...timings);
      ok(errs === 0, `${ep.name}: ${BURST} concurrent reads, 0 errors`, `p50 ${p50}ms · p95 ${p95}ms · max ${max}ms`);
      // A public read over ~2s under burst would feel broken on a phone.
      ok(p95 <= 2000, `${ep.name}: p95 under 2s at burst`, `${p95}ms`);
    }
  } finally {
    await cleanup();
    console.log('\n  (throwaway tournament removed)');
  }

  console.log(failures === 0
    ? '\n✅ CAPACITY — the platform takes tournament-day traffic'
    : `\n❌ CAPACITY — ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
