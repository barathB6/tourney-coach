// End-to-end check for the Contest Hole Manager data model against the real
// schema. Probes for migration 031; if applied, exercises all four contest
// types + entries through the DB and validates the lib/contests logic on the
// round-tripped rows, then cleans up. Run: npx tsx scripts/e2e-contests.ts
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import {
  rankEntries, rankByCategory, potCents, payoutBreakdown, dollarsFromCents,
  yardsToInches, feetInchesToInches, isDecided,
} from '../lib/contests';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '');
const s = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { c ? pass++ : (fail++, console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`)); };

(async () => {
  // ── Probe ──
  const probe = await s.from('contest_holes').select('insurance_status, winners, category_mode, entry_fee_cents, witnesses, location_label').limit(1);
  const probe2 = await s.from('contest_entries').select('value_inches, category').limit(1);
  if (probe.error || probe2.error) {
    console.log('⚠ PENDING MIGRATION 031 — run db/migrations/031_contest_manager.sql, then re-run this script.');
    console.log(`   (${probe.error?.message || probe2.error?.message})`);
    process.exit(0);
  }
  console.log('✓ migration 031 applied — running full flow\n');

  const { data: t } = await s.from('tournaments').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!t) { console.log('No tournament to test against.'); process.exit(0); }
  const tid = t.id as string;
  const made: string[] = [];

  try {
    // ── Create one of each contest type ──
    const mk = async (row: Record<string, unknown>) => {
      const { data, error } = await s.from('contest_holes').insert({ tournament_id: tid, ...row }).select('id').single();
      if (error) throw new Error(error.message);
      made.push(data.id); return data.id as string;
    };
    const hio = await mk({ hole_number: 12, contest_type: 'hole_in_one', prize: '2026 Camry', prize_value_cents: 840000, insurance_status: 'paid', insurance_cost_cents: 47500, witnesses: [{ name: 'A', confirmed: true }, { name: 'B', confirmed: true }] });
    const ctp = await mk({ hole_number: 5, contest_type: 'closest_to_pin', prize: '$250 card' });
    const ld = await mk({ hole_number: 7, contest_type: 'long_drive', category_mode: 'by_gender' });
    const putt = await mk({ hole_number: null, contest_type: 'putting', location_label: 'Practice green', entry_fee_cents: 1000, payout_split: '60/30/10' });
    ok('created 4 contests', made.length === 4);
    ok('putting allows null hole', true); // insert above would have thrown otherwise

    // ── CTP entries: lower wins ──
    await s.from('contest_entries').insert([
      { contest_hole_id: ctp, player_name: 'Far', value_inches: feetInchesToInches(20, 0) },
      { contest_hole_id: ctp, player_name: 'Close', value_inches: feetInchesToInches(3, 2) },
      { contest_hole_id: ctp, player_name: 'Mid', value_inches: feetInchesToInches(11, 6) },
    ]);
    const { data: ctpE } = await s.from('contest_entries').select('*').eq('contest_hole_id', ctp);
    const ctpRank = rankEntries(ctpE!, 'closest_to_pin');
    ok('ctp leader is closest', ctpRank[0].player_name === 'Close', ctpRank[0].player_name);
    ok('ctp worst is farthest', ctpRank[2].player_name === 'Far');

    // ── LD entries by category: higher wins ──
    await s.from('contest_entries').insert([
      { contest_hole_id: ld, player_name: 'M-Long', value_inches: yardsToInches(305), category: "Men's" },
      { contest_hole_id: ld, player_name: 'M-Short', value_inches: yardsToInches(270), category: "Men's" },
      { contest_hole_id: ld, player_name: 'W-Long', value_inches: yardsToInches(255), category: "Women's" },
    ]);
    const { data: ldE } = await s.from('contest_entries').select('*').eq('contest_hole_id', ld);
    const ldGroups = rankByCategory(ldE!, 'long_drive', true);
    ok('ld two categories', ldGroups.length === 2);
    const mens = ldGroups.find((g) => g.category === "Men's")!;
    ok("ld men's leader is longest", mens.entries[0].player_name === 'M-Long');

    // ── Putting entrants → pot ──
    await s.from('contest_entries').insert(
      Array.from({ length: 47 }, (_, i) => ({ contest_hole_id: putt, player_name: `Golfer ${i + 1}` })),
    );
    const { count } = await s.from('contest_entries').select('*', { count: 'exact', head: true }).eq('contest_hole_id', putt);
    const pot = potCents(1000, count ?? 0);
    ok('putting 47 entrants', count === 47, `${count}`);
    ok('pot = $470', pot === 47000, dollarsFromCents(pot));
    const payout = payoutBreakdown(pot, '60/30/10');
    ok('payout sums to pot', payout.reduce((a, p) => a + p.cents, 0) === pot);
    ok('1st place = $282', payout[0].cents === 28200, dollarsFromCents(payout[0].cents));

    // ── Winners tracked ──
    await s.from('contest_holes').update({ winner_name: 'Close', winner_detail: '3 ft 2 in', decided_at: new Date().toISOString() }).eq('id', ctp);
    await s.from('contest_holes').update({ winners: [{ name: 'P1', detail: '$282', place: 1 }], decided_at: new Date().toISOString() }).eq('id', putt);
    const { data: decidedRows } = await s.from('contest_holes').select('contest_type, winner_name, winners').in('id', [ctp, putt, hio]);
    ok('ctp decided', isDecided(decidedRows!.find((r) => r.contest_type === 'closest_to_pin')! as { contest_type: 'closest_to_pin'; winner_name: string }));
    ok('putting decided by winners[]', isDecided(decidedRows!.find((r) => r.contest_type === 'putting')! as { contest_type: 'putting'; winners: unknown[] }));
    ok('hio still undecided', !isDecided(decidedRows!.find((r) => r.contest_type === 'hole_in_one')! as { contest_type: 'hole_in_one'; winner_name: null }));
  } finally {
    // ── Cleanup (cascade removes entries) ──
    if (made.length) await s.from('contest_holes').delete().in('id', made);
    const { data: leftover } = await s.from('contest_entries').select('id').in('contest_hole_id', made);
    ok('cleanup cascaded entries', (leftover?.length ?? 0) === 0);
  }

  console.log(`\ncontests e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
