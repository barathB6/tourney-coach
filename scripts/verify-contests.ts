// Unit checks for lib/contests pure logic. Run: npx tsx scripts/verify-contests.ts
import {
  rankEntries, rankByCategory, potCents, parseSplit, payoutBreakdown,
  feetInchesToInches, formatFeetInches, formatYards, yardsToInches,
  dollarsFromCents, confirmedWitnessCount, isDecided,
} from '../lib/contests';

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── closest-to-pin: lower wins, ties share a place (1,1,3) ──
{
  const e = [
    { player_name: 'A', value_inches: 148 },
    { player_name: 'B', value_inches: 62 },
    { player_name: 'C', value_inches: 62 },
    { player_name: 'D', value_inches: null },   // no measurement — excluded
    { player_name: 'E', value_inches: 205 },
  ];
  const r = rankEntries(e, 'closest_to_pin');
  ok('ctp excludes unmeasured', r.length === 4);
  ok('ctp lowest first', r[0].player_name === 'B' || r[0].player_name === 'C');
  ok('ctp tie shares rank 1', r[0].rank === 1 && r[1].rank === 1);
  ok('ctp skips to rank 3 after tie', r[2].rank === 3, `got ${r[2].rank}`);
  ok('ctp third is A (148in)', r[2].player_name === 'A' && r[2].rank === 3);
  ok('ctp last is farthest E (205in)', r[3].player_name === 'E' && r[3].rank === 4);
}

// ── long-drive: higher wins ──
{
  const e = [
    { player_name: 'A', value_inches: yardsToInches(287) },
    { player_name: 'B', value_inches: yardsToInches(301) },
    { player_name: 'C', value_inches: yardsToInches(266) },
  ];
  const r = rankEntries(e, 'long_drive');
  ok('long-drive highest first', r[0].player_name === 'B' && r[0].rank === 1);
  ok('long-drive last is shortest', r[2].player_name === 'C');
}

// ── category split ──
{
  const e = [
    { player_name: 'M1', value_inches: yardsToInches(300), category: "Men's" },
    { player_name: 'W1', value_inches: yardsToInches(240), category: "Women's" },
    { player_name: 'M2', value_inches: yardsToInches(280), category: "Men's" },
  ];
  const grouped = rankByCategory(e, 'long_drive', true);
  ok('two categories', grouped.length === 2);
  ok("men's ranked", grouped[0].entries[0].player_name === 'M1' && grouped[0].entries[1].rank === 2);
  const open = rankByCategory(e, 'long_drive', false);
  ok('open is single group', open.length === 1 && open[0].entries.length === 3);
}

// ── putting pot + payout (no lost/invented pennies) ──
{
  ok('pot = fee * entrants', potCents(1000, 47) === 47000);
  ok('pot 0 when no entrants', potCents(1000, 0) === 0);
  ok('parseSplit 60/30/10', JSON.stringify(parseSplit('60/30/10')) === '[60,30,10]');
  ok('parseSplit tolerant', JSON.stringify(parseSplit('50, 30, 20')) === '[50,30,20]');

  const pot = 47000;
  const b = payoutBreakdown(pot, '60/30/10');
  ok('3 payout places', b.length === 3);
  ok('payout sums to pot exactly', b.reduce((s, p) => s + p.cents, 0) === pot, `${b.reduce((s, p) => s + p.cents, 0)}`);
  ok('payout places ordered', b[0].place === 1 && b[0].cents >= b[1].cents && b[1].cents >= b[2].cents);

  // remainder distribution: 100 cents / 3 equal → 34/33/33 = 100
  const odd = payoutBreakdown(100, '1/1/1');
  ok('odd split still sums', odd.reduce((s, p) => s + p.cents, 0) === 100, JSON.stringify(odd.map((x) => x.cents)));
  ok('empty split → no payout', payoutBreakdown(1000, '').length === 0);
  ok('zero pot → no payout', payoutBreakdown(0, '60/30/10').length === 0);
}

// ── conversions & formatting ──
{
  ok('feetInches → inches', feetInchesToInches(12, 4) === 148);
  ok('format 148in = 12 ft 4 in', formatFeetInches(148) === '12 ft 4 in', formatFeetInches(148));
  ok('format exact feet', formatFeetInches(24) === '2 ft');
  ok('format inches only', formatFeetInches(7) === '7 in');
  ok('format null', formatFeetInches(null) === '—');
  ok('format yards', formatYards(yardsToInches(287)) === '287 yds', formatYards(yardsToInches(287)));
  ok('dollars whole', dollarsFromCents(47000) === '$470');
  ok('dollars cents', dollarsFromCents(28200) === '$282');
  ok('dollars fractional', dollarsFromCents(1550) === '$15.50');
}

// ── witnesses & decided ──
{
  ok('witness count', confirmedWitnessCount([{ name: 'a', confirmed: true }, { name: 'b', confirmed: false }]) === 1);
  ok('witness count bad input', confirmedWitnessCount(null) === 0);
  ok('hio decided by winner', isDecided({ contest_type: 'hole_in_one', winner_name: 'Jordan' }));
  ok('hio undecided', !isDecided({ contest_type: 'hole_in_one', winner_name: null }));
  ok('putting decided by winners[]', isDecided({ contest_type: 'putting', winners: [{ name: 'x' }] }));
  ok('putting undecided empty', !isDecided({ contest_type: 'putting', winners: [] }));
}

console.log(`\ncontests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
