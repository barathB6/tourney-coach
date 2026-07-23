// Day 21 verification harness — drives the pure leaderboard engine against
// synthetic tournaments. PURE + OFFLINE: no database, deterministic, CI-safe.
//   npx tsx scripts/verify-leaderboard.ts
import {
  applyMaxScore,
  computeStandings,
  countbackCompare,
  latestScores,
  maxScoreCap,
  recentFormFromHoleRows,
  type HoleInfo,
  type ScoreRow,
  type TeamInfo,
} from '../lib/scoring/leaderboard';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const section = (t: string) => console.log(`\n${t}`);

const HOLES: HoleInfo[] = Array.from({ length: 18 }, (_, i) => ({
  holeNumber: i + 1,
  par: [4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 5, 3, 4, 4, 3, 5, 4, 4][i], // par 72, front 36 back 36
}));
const par = (h: number) => HOLES[h - 1].par!;
const team = (id: string, name: string, foursome: number): TeamInfo => ({
  registrationId: id, teamName: name, contactName: `${name} contact`, foursomeNumber: foursome,
});
const at = (min: number) => new Date(Date.UTC(2026, 6, 22, 8, min)).toISOString();
// score every hole in `holes` at par + delta
const cardAt = (id: string, holes: number[], delta: (h: number) => number, tMin = 0): ScoreRow[] =>
  holes.map((h, i) => ({ registrationId: id, holeNumber: h, strokes: par(h) + delta(h), submittedAt: at(tMin + i) }));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ── 1. Max score rule ───────────────────────────────────────────────────────
section('1. Max score rule (pick-up-at-par / double bogey / none)');
{
  ok(maxScoreCap('par', 4) === 4 && maxScoreCap('double_bogey', 4) === 6 && maxScoreCap('none', 4) === null, 'caps: par→4, double_bogey→6, none→null');
  ok(maxScoreCap('par', null) === null, 'no par entered → no cap computable');
  const a = applyMaxScore('par', 4, 7);
  const b = applyMaxScore('par', 4, 4);
  const c = applyMaxScore('double_bogey', 5, 7);
  ok(a.strokes === 4 && a.capped, 'entered 7 on par 4 under pick-up-at-par → recorded 4, flagged for friendly message');
  ok(b.strokes === 4 && !b.capped, 'at the cap → unflagged');
  ok(c.strokes === 7 && !c.capped, '7 on par 5 under double bogey (cap 7) → allowed');
}

// ── 2. Latest-wins resubmission (late submissions + corrections) ───────────
section('2. Latest submission wins per (team, hole)');
{
  const rows: ScoreRow[] = [
    { registrationId: 'A', holeNumber: 1, strokes: 6, submittedAt: at(10) },
    { registrationId: 'A', holeNumber: 1, strokes: 4, submittedAt: at(20) }, // resubmit fixes it
    { registrationId: 'A', holeNumber: 2, strokes: 3, submittedAt: at(30) },
    { registrationId: 'A', holeNumber: 2, strokes: 5, submittedAt: at(25) }, // LATE arrival of an older submission
  ];
  const latest = latestScores(rows);
  ok(latest.get('A')!.get(1)!.strokes === 4, 'resubmission overrides earlier score');
  ok(latest.get('A')!.get(2)!.strokes === 3, 'late-arriving OLDER submission does not override newer one');
}

// ── 3. Standings arithmetic + mid-round fairness ────────────────────────────
section('3. Standings: to-par ranking, thru, shotgun mid-round fairness');
{
  const teams = [team('A', 'Eagles', 1), team('B', 'Birdies', 2), team('C', 'Pars', 3), team('D', 'Waiting', 4)];
  const scores: ScoreRow[] = [
    // A: -2 through 9 (started hole 1)
    ...cardAt('A', range(1, 9), (h) => (h === 3 || h === 8 ? -1 : 0)),
    // B: -2 through 5 (fewer holes, same to-par → tied by to-par, not behind)
    ...cardAt('B', range(1, 5), (h) => (h <= 2 ? -1 : 0), 20),
    // C: +3 through 9, started hole 10 (shotgun)
    ...cardAt('C', [...range(10, 18)], (h) => (h === 11 || h === 14 || h === 17 ? 1 : 0), 40),
  ];
  const s = computeStandings({ format: 'scramble', maxScoreRule: 'par', teams, holes: HOLES, scores });
  const byId = Object.fromEntries(s.map((r) => [r.registrationId, r]));
  ok(byId['A'].toPar === -2 && byId['A'].holesCompleted === 9, 'Eagles -2 thru 9', `toPar ${byId['A'].toPar}`);
  ok(byId['B'].toPar === -2 && byId['B'].holesCompleted === 5, 'Birdies -2 thru 5');
  ok(byId['A'].rank === 1 && byId['B'].rank === 1 && byId['A'].tied && byId['B'].tied, 'same to-par mid-round → shared rank (more holes played is not an advantage)');
  ok(byId['C'].rank === 3, 'shotgun starter ranked by to-par like everyone else', `rank ${byId['C'].rank}`);
  ok(byId['D'].holesCompleted === 0 && byId['D'].rank === 4, 'team with no scores sorts last');
}

// ── 4. Countback tie-breaking (USGA card countback) ────────────────────────
section('4. Tie-breaking: back-9 → last-6 → last-3 → 18th countback');
{
  const pars = new Map(HOLES.map((h) => [h.holeNumber, h.par!]));
  // Both finish 18 holes at even par overall.
  const evenCard = (id: string, backNineDelta: (h: number) => number, frontDelta: (h: number) => number): Record<number, number> => {
    const holeScores: Record<number, number> = {};
    for (const h of range(1, 9)) holeScores[h] = par(h) + frontDelta(h);
    for (const h of range(10, 18)) holeScores[h] = par(h) + backNineDelta(h);
    return holeScores;
  };
  // X: back nine -1 (birdie on 10), front +1. Y: back nine +1 (bogey 10), front -1.
  const X = { holeScores: evenCard('X', (h) => (h === 10 ? -1 : 0), (h) => (h === 1 ? 1 : 0)) };
  const Y = { holeScores: evenCard('Y', (h) => (h === 10 ? 1 : 0), (h) => (h === 1 ? -1 : 0)) };
  ok(countbackCompare(X, Y, pars) < 0, 'better back nine wins the countback');
  // Same back nine total → falls to last six: give Y a birdie on 11 (still same back-9? -1+1 = 0 vs X -1... adjust)
  const X2 = { holeScores: evenCard('X2', (h) => (h === 10 ? -1 : 0), () => 0) };            // back9 -1, last6 0
  const Y2 = { holeScores: evenCard('Y2', (h) => (h === 16 ? -1 : 0), () => 0) };            // back9 -1, last6 -1
  ok(countbackCompare(Y2, X2, pars) < 0, 'equal back nine → decided on last six');
  const Z1 = { holeScores: evenCard('Z1', () => 0, () => 0) };
  const Z2 = { holeScores: evenCard('Z2', () => 0, () => 0) };
  ok(countbackCompare(Z1, Z2, pars) === 0, 'identical cards → true tie (shared rank)');

  // Through standings: X and Y both even overall → X ranked 1, Y ranked 2, no tie flag
  const teams = [team('X', 'X', 1), team('Y', 'Y', 2)];
  const scores = [
    ...Object.entries(X.holeScores).map(([h, s], i) => ({ registrationId: 'X', holeNumber: Number(h), strokes: s, submittedAt: at(i) })),
    ...Object.entries(Y.holeScores).map(([h, s], i) => ({ registrationId: 'Y', holeNumber: Number(h), strokes: s, submittedAt: at(i) })),
  ];
  const s2 = computeStandings({ format: 'stroke_play', maxScoreRule: 'none', teams, holes: HOLES, scores });
  ok(s2[0].registrationId === 'X' && s2[0].rank === 1 && s2[1].rank === 2 && !s2[0].tied, 'countback breaks the RANK, not just the order', `${s2[0].teamName} then ${s2[1].teamName}`);
}

// ── 5. No pars entered → total-strokes fallback ────────────────────────────
section('5. Course without pars → total strokes fallback');
{
  const bareHoles: HoleInfo[] = range(1, 18).map((h) => ({ holeNumber: h, par: null }));
  const teams = [team('A', 'Low', 1), team('B', 'High', 2)];
  const scores = [
    ...range(1, 3).map((h, i) => ({ registrationId: 'A', holeNumber: h, strokes: 4, submittedAt: at(i) })),
    ...range(1, 3).map((h, i) => ({ registrationId: 'B', holeNumber: h, strokes: 5, submittedAt: at(i) })),
  ];
  const s = computeStandings({ format: 'stroke_play', maxScoreRule: 'none', teams, holes: bareHoles, scores });
  ok(s[0].registrationId === 'A' && s[0].toPar === null && s[0].totalStrokes === 12, 'ranks by total strokes with toPar null', `${s[0].totalStrokes} vs ${s[1].totalStrokes}`);
}

// ── 6. Mixed known/unknown pars → event-wide to-par, not per-team ──────────
section('6. Event-wide fallback: a team touching a par-less hole is not mis-ranked');
{
  // holes 1,2 par 4; hole 3 has NO par entered.
  const holes: HoleInfo[] = [{ holeNumber: 1, par: 4 }, { holeNumber: 2, par: 4 }, { holeNumber: 3, par: null }];
  const teams = [team('GOOD', 'Birdies', 1), team('BAD', 'Bogeys', 2)];
  const scores: ScoreRow[] = [
    // GOOD birdies all three (touches the par-less hole 3)
    { registrationId: 'GOOD', holeNumber: 1, strokes: 3, submittedAt: at(1) },
    { registrationId: 'GOOD', holeNumber: 2, strokes: 3, submittedAt: at(2) },
    { registrationId: 'GOOD', holeNumber: 3, strokes: 3, submittedAt: at(3) },
    // BAD plays two 7s on par 4 (+6), never touches hole 3
    { registrationId: 'BAD', holeNumber: 1, strokes: 7, submittedAt: at(1) },
    { registrationId: 'BAD', holeNumber: 2, strokes: 7, submittedAt: at(2) },
  ];
  const s = computeStandings({ format: 'stroke_play', maxScoreRule: 'none', teams, holes, scores });
  ok(s[0].registrationId === 'GOOD' && s[0].rank === 1, 'the birdying team leads despite touching a par-less hole', `${s[0].teamName} toPar ${s[0].toPar}`);
  ok(s[0].toPar === -2 && s[1].toPar === 6, 'to-par computed over known-par holes only', `${s[0].toPar} vs ${s[1].toPar}`);
}

// ── 7. 9-hole event countback ──────────────────────────────────────────────
section('7. Countback works for a 9-hole event (last 6 / 3 / 1, not 10–18)');
{
  const nineHoles: HoleInfo[] = range(1, 9).map((h) => ({ holeNumber: h, par: 4 }));
  const pars9 = new Map(nineHoles.map((h) => [h.holeNumber, 4]));
  // Both even over 9; A better on the last 3 (birdie hole 9), B worse.
  const cardA: Record<number, number> = {}; const cardB: Record<number, number> = {};
  for (const h of range(1, 9)) { cardA[h] = 4; cardB[h] = 4; }
  cardA[1] = 5; cardA[9] = 3; // A: +1 early, -1 on 9  → last-3 = -1
  cardB[8] = 5; cardB[7] = 3; // B: even on 9, last-3 = 0
  ok(countbackCompare({ holeScores: cardA }, { holeScores: cardB }, pars9) < 0, 'a 9-hole event breaks the tie on the closing holes', 'A wins last-3');
}

// ── 8. Intransitive mid-round countback → left tied, never contradictory ───
section('8. Mid-round teams on different segments stay tied (no self-contradicting ranks)');
{
  // Three teams even-par but each completed a different number of back-nine holes.
  const teams = [team('A', 'A', 1), team('B', 'B', 2), team('C', 'C', 3)];
  const mk = (id: string, holes: number[], deltas: Record<number, number>): ScoreRow[] =>
    holes.map((h, i) => ({ registrationId: id, holeNumber: h, strokes: par(h) + (deltas[h] ?? 0), submittedAt: at(i) }));
  const scores = [
    ...mk('A', [16, 17, 18], {}),                              // E thru 3
    ...mk('B', range(13, 18), { 13: 1, 16: -1 }),              // E thru 6
    ...mk('C', range(10, 18), { 10: 1, 11: 1, 13: -1, 14: -1 }), // E thru 9
  ];
  const s = computeStandings({ format: 'stroke_play', maxScoreRule: 'none', teams, holes: HOLES, scores });
  // None finished the round (18 holes) → all three share the top rank, no contradiction.
  ok(s.every((r) => r.rank === s[0].rank && r.tied), 'unfinished equal-to-par teams all share one rank', `ranks ${s.map((r) => r.rank).join(',')}`);
}

// ── 9. Recent-form trend (TV board momentum, honestly derived) ─────────────
section('9. Recent-form trend over the last N submitted holes');
{
  const holes: HoleInfo[] = range(1, 9).map((h) => ({ holeNumber: h, par: 4 }));
  const pars = new Map(holes.map((h) => [h.holeNumber, 4]));
  // Team recently birdied holes 7,8,9 (submitted last), earlier holes at par.
  const hot: ScoreRow[] = [
    ...range(1, 6).map((h, i) => ({ registrationId: 'H', holeNumber: h, strokes: 4, submittedAt: at(i) })),
    { registrationId: 'H', holeNumber: 7, strokes: 3, submittedAt: at(20) },
    { registrationId: 'H', holeNumber: 8, strokes: 3, submittedAt: at(21) },
    { registrationId: 'H', holeNumber: 9, strokes: 3, submittedAt: at(22) },
  ];
  const t = recentFormFromHoleRows(hot.filter((r) => [7, 8, 9].concat(range(1, 6)).includes(r.holeNumber)), pars, 3)!;
  ok(t.direction === 'up' && t.toPar === -3 && t.holes === 3, 'three recent birdies → up trend, -3 over 3 holes', `${t.direction} ${t.toPar}`);
  const cold = recentFormFromHoleRows([{ registrationId: 'C', holeNumber: 9, strokes: 6, submittedAt: at(30) }], pars, 3)!;
  ok(cold.direction === 'down' && cold.toPar === 2, 'a recent double → down trend', `${cold.direction} ${cold.toPar}`);
  ok(recentFormFromHoleRows([], pars, 3) === null, 'no scores → null (UI shows a neutral dash, not a made-up number)');
  const noPar = recentFormFromHoleRows([{ registrationId: 'N', holeNumber: 1, strokes: 4, submittedAt: at(1) }], new Map(), 3);
  ok(noPar === null, 'no pars → null trend');
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
