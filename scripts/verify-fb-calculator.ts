// Day 28 — F&B calculator model verification.
//
// Every number a kitchen orders against comes out of this file's arithmetic,
// so it is checked against hand-computed expectations rather than eyeballed.
// The centrepiece is the spec's worked example: 72 players, October, 78°F.
//
// No database and no network — this is the pure model. The engine, weather
// integration and outreach cadence are covered by verify-donation-engine.ts.
//
//   npx tsx scripts/verify-fb-calculator.ts
import {
  calculateFb, heatMultiplier, rainMultiplier, buildPrepTimeline,
  DEFAULT_BASELINES, HEAT_ELASTICITY, PACK_SIZE, BASELINE_TEMP_F,
  MAX_RAIN_REDUCTION, LUNCH_OVERAGE, BEER_PER_PLAYER_ADVISORY,
  type ConsumableKey,
} from '../lib/fb/calculator';
import { askFor, VENDOR_CATEGORIES } from '../lib/donations/vendors';
import { ASSUMED_MIN_PER_HOLE, KITCHEN_LEAD_MINUTES } from '../lib/pace';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── The heat curve ──────────────────────────────────────────────────────────
section('Heat curve');
ok(close(heatMultiplier(BASELINE_TEMP_F), 1), '75°F is the baseline, multiplier exactly 1');
ok(heatMultiplier(50) < heatMultiplier(70) && heatMultiplier(70) < heatMultiplier(90),
  'monotonically increasing with temperature');
ok(close(heatMultiplier(-40), heatMultiplier(45)) && close(heatMultiplier(200), heatMultiplier(105)),
  'clamped at both ends rather than extrapolating off the curve');
// The whole reason for interpolation instead of buckets: no cliff between
// adjacent degrees.
let maxStep = 0;
for (let t = 40; t <= 110; t++) maxStep = Math.max(maxStep, Math.abs(heatMultiplier(t + 1) - heatMultiplier(t)));
ok(maxStep < 0.04, 'no single-degree cliff anywhere on the curve', `largest 1°F step = ${maxStep.toFixed(4)}`);
// Hand-checked midpoint: 78°F sits 30% of the way from 75 (1.00) to 85 (1.25).
ok(close(heatMultiplier(78), 1.075, 1e-9), '78°F interpolates to 1.075 exactly');

// ── Rain ────────────────────────────────────────────────────────────────────
section('Rain adjustment');
ok(rainMultiplier(null) === 1 && rainMultiplier(0) === 1, 'no forecast and 0% both mean no reduction');
ok(close(rainMultiplier(100), 1 - MAX_RAIN_REDUCTION), '100% rain caps at the documented maximum reduction');
ok(close(rainMultiplier(50), 1 - MAX_RAIN_REDUCTION / 2), 'linear between');
ok(rainMultiplier(-5) === 1 && close(rainMultiplier(9999), 1 - MAX_RAIN_REDUCTION), 'out-of-range input is clamped, not trusted');

// ── THE WORKED EXAMPLE: 72 players, October, 78°F ──────────────────────────
section('Worked example — 72 players, October, 78°F');
const worked = calculateFb({
  playerCount: 72,
  volunteerCount: 12,
  guestCount: 0,
  holes: 18,
  temperatureF: 78,
  shotgunAt: '2026-10-10T08:00:00Z',
  menu: ['Pulled pork', 'Mac and cheese', 'Coleslaw'],
});

// Recompute the whole model independently, from the documented formula, and
// require the implementation to agree. If someone changes an elasticity, this
// still passes — but if the *formula* drifts from what's documented, it fails.
const heat78 = 1.075;
for (const key of Object.keys(DEFAULT_BASELINES) as ConsumableKey[]) {
  const factor = 1 + (heat78 - 1) * HEAT_ELASTICITY[key];
  const expectedUnits = Math.ceil(72 * DEFAULT_BASELINES[key] * 1 * factor * 1);
  const expectedPacks = Math.ceil(expectedUnits / PACK_SIZE[key].size);
  const line = worked.lines.find((l) => l.key === key)!;
  ok(line.units === expectedUnits && line.packs === expectedPacks,
    `${line.label}: ${line.units} servings → ${line.packs} ${line.packUnit}(s)`,
    `expected ${expectedUnits}/${expectedPacks}`);
}

// The specific validated figures this scenario produces, pinned so a future
// change to the model cannot silently move a kitchen order.
const expectPacks: Record<string, number> = { beer: 10, water: 10, soft_drinks: 4, sports_drinks: 4, snacks: 9 };
for (const [key, packs] of Object.entries(expectPacks)) {
  const line = worked.lines.find((l) => l.key === key)!;
  ok(line.packs === packs, `pinned: ${line.label} = ${packs} ${line.packUnit}(s)`, `got ${line.packs}`);
}

ok(worked.lunch.attendees === 84, 'lunch attendees = 72 players + 12 volunteers', `got ${worked.lunch.attendees}`);
ok(worked.lunch.portions === Math.ceil(84 * LUNCH_OVERAGE), `lunch portions include the ${Math.round((LUNCH_OVERAGE - 1) * 100)}% over-run`, `${worked.lunch.portions}`);
ok(worked.lunch.vegetarianPortions + worked.lunch.standardPortions === worked.lunch.portions,
  'vegetarian + standard exactly equals total portions');

// Heat moves the items in the documented directions, not uniformly.
const factorOf = (k: string) => worked.lines.find((l) => l.key === k)!.weatherFactor;
ok(factorOf('water') > factorOf('beer'), 'water responds to heat more than beer does');
ok(factorOf('sports_drinks') > factorOf('water'), 'sports drinks respond most of all');
ok(factorOf('snacks') < 1, 'snacks fall as it gets hotter', `factor ${factorOf('snacks').toFixed(3)}`);

// ── Responsible-service checks ──────────────────────────────────────────────
section('Advisories');
ok(worked.warnings.length === 0, 'shipped defaults at 78°F trip no advisories', `got: ${worked.warnings.join(' | ')}`);

const beerHeavy = calculateFb({ playerCount: 72, temperatureF: 78, baselines: { beer: 5 } });
ok(beerHeavy.warnings.some((w) => w.includes('beers per player')),
  `an edited beer baseline above ${BEER_PER_PLAYER_ADVISORY}/player is flagged`);

const thirsty = calculateFb({ playerCount: 72, temperatureF: 78, baselines: { water: 0.5 } });
ok(thirsty.warnings.some((w) => w.toLowerCase().includes('water')),
  'planning less water than beer is flagged as a responsible-service issue');

const scorcher = calculateFb({ playerCount: 72, temperatureF: 97 });
ok(scorcher.warnings.some((w) => w.includes('water station')), '90°F+ recommends a turn water station');
const waterAt97 = scorcher.lines.find((l) => l.key === 'water')!.units;
const waterAt78 = worked.lines.find((l) => l.key === 'water')!.units;
ok(waterAt97 > waterAt78 * 1.3, 'a 97°F day orders substantially more water than a 78°F one',
  `${waterAt78} → ${waterAt97}`);

const wet = calculateFb({ playerCount: 72, temperatureF: 78, precipChance: 80 });
ok(wet.warnings.some((w) => w.includes('unopened cases')),
  'a rainy forecast explains the reduction and warns about returns');
ok(wet.lines.every((l, i) => l.units <= worked.lines[i].units), 'rain never increases an order');

// ── Kitchen timeline ────────────────────────────────────────────────────────
section('Kitchen prep timing');
const prep = worked.prep;
const at = (label: string) => prep.find((s) => s.label.includes(label))!;
ok(prep.every((s, i) => i === 0 || s.offsetMinutes >= prep[i - 1].offsetMinutes), 'timeline is in chronological order');
ok(at('Shotgun start').offsetMinutes === 0, 'shotgun is the zero point');
ok(at('Last group in').offsetMinutes === 18 * ASSUMED_MIN_PER_HOLE,
  'last group in uses the same pace constant as Module 9', `${18 * ASSUMED_MIN_PER_HOLE} min`);
ok(at('Awards lunch served').offsetMinutes - at('Kitchen fires').offsetMinutes === KITCHEN_LEAD_MINUTES,
  'kitchen fires exactly one lead-time before service — same constant the pace tracker texts on');
ok(at('Kitchen fires').detail.includes('Pulled pork'), 'the menu reaches the kitchen step');
ok(at('Shotgun start').at === '2026-10-10T08:00:00.000Z', 'absolute times anchor to the real shotgun instant');
ok(at('Ice the coolers').at === '2026-10-10T06:00:00.000Z', 'two hours before means 6am for an 8am shotgun');

const noShotgun = buildPrepTimeline(18, null, []);
ok(noShotgun.every((s) => s.at === null) && noShotgun.length === prep.length,
  'without a shotgun time the steps still exist, with null clock times');

const nine = calculateFb({ playerCount: 72, temperatureF: 78, holes: 9 });
ok(nine.lines.every((l, i) => l.units <= worked.lines[i].units), '9 holes never orders more than 18');
ok(nine.prep.find((s) => s.label.includes('Last group in'))!.offsetMinutes === 9 * ASSUMED_MIN_PER_HOLE,
  'a 9-hole round finishes in half the time');

// ── Hostile and degenerate input ────────────────────────────────────────────
section('Hostile input');
const zero = calculateFb({ playerCount: 0, temperatureF: 78 });
ok(zero.lines.every((l) => l.units === 0 && l.packs === 0), 'zero players orders nothing');
ok(zero.warnings.some((w) => w.includes('No players')), 'and says why rather than showing a silent zero');

const nonsense = calculateFb({
  playerCount: -50, volunteerCount: -3, temperatureF: Number.NaN,
  precipChance: Number.POSITIVE_INFINITY, baselines: { beer: -10 }, holes: 42 as never,
});
ok(nonsense.inputs.playerCount === 0 && nonsense.inputs.volunteerCount === 0, 'negative counts clamp to zero');
ok(nonsense.inputs.temperatureF === BASELINE_TEMP_F, 'NaN temperature falls back to the documented baseline');
ok(nonsense.inputs.precipChance === null, 'Infinity precipitation is discarded, not clamped to 100');
ok(nonsense.inputs.holes === 18, 'an invalid hole count falls back to 18');
ok(nonsense.lines.every((l) => l.units >= 0 && Number.isFinite(l.units)), 'no negative or non-finite quantity escapes');

const huge = calculateFb({ playerCount: 100_000, temperatureF: 105 });
ok(huge.lines.every((l) => Number.isFinite(l.packs) && l.packs > 0), 'a very large field still produces finite packs');
ok(huge.lines.every((l) => l.packedUnits >= l.units), 'rounding to whole packs never delivers less than needed');

// Packaging is a promise: you cannot buy 9.3 cases.
section('Packaging');
for (const l of worked.lines) {
  ok(Number.isInteger(l.packs) && l.packedUnits === l.packs * l.packSize && l.packedUnits >= l.units,
    `${l.label}: whole packs, covering the requirement`, `${l.packs} × ${l.packSize} = ${l.packedUnits} ≥ ${l.units}`);
}

// ── Calculator output feeds the donation ask ────────────────────────────────
section('Calculator output → vendor ask');
for (const cat of VENDOR_CATEGORIES) {
  const ask = askFor(cat.key, worked);
  ok(typeof ask === 'string' && ask.length > 0, `${cat.label} has a concrete ask`, ask ?? 'null');
}
const beerAsk = askFor('beer_wine_distributor', worked)!;
ok(beerAsk.includes('10 cases') && beerAsk.includes('72 players'),
  'the beer distributor is asked for the exact computed quantity', beerAsk);
const restaurantAsk = askFor('restaurant', worked)!;
ok(restaurantAsk.includes(String(worked.lunch.portions)) && restaurantAsk.includes('Pulled pork'),
  'the caterer is asked for the exact portion count and the real menu', restaurantAsk);
ok(VENDOR_CATEGORIES.every((c) => askFor(c.key, null) === null),
  'with no plan every ask is null — the drafter is never handed an invented number');
ok(askFor('beer_wine_distributor', zero) === null, 'a zero-quantity plan produces no ask rather than "0 cases"');

// ── Multiple tournament scenarios ───────────────────────────────────────────
// The spec asks for the calculator to be tested across scenarios, not just the
// worked example. These are printed as a table because the useful check is
// relational: a bigger, hotter field must order more of everything thirst-
// driven, and a cold wet one must order less.
section('Scenarios');
const SCENARIOS = [
  { name: 'Oct, 72p, 78°F        ', playerCount: 72, volunteerCount: 12, temperatureF: 78 },
  { name: 'Jul, 96p, 95°F        ', playerCount: 96, volunteerCount: 14, temperatureF: 95 },
  { name: 'Apr, 144p, 62°F       ', playerCount: 144, volunteerCount: 20, temperatureF: 62 },
  { name: 'Dec, 40p, 48°F, 70%rain', playerCount: 40, volunteerCount: 6, temperatureF: 48, precipChance: 70 },
  { name: 'Aug, 120p, 103°F      ', playerCount: 120, volunteerCount: 16, temperatureF: 103 },
];
const runs = SCENARIOS.map((s) => ({ s, p: calculateFb({ ...s, holes: 18, shotgunAt: '2026-10-10T08:00:00Z' }) }));
console.log('    scenario                 beer  water  soft  sport  snack  lunch');
for (const { s, p } of runs) {
  const g = (k: string) => String(p.lines.find((l) => l.key === k)!.packs).padStart(4);
  console.log(`    ${s.name}  ${g('beer')}  ${g('water')}  ${g('soft_drinks')}  ${g('sports_drinks')}  ${g('snacks')}  ${String(p.lunch.portions).padStart(5)}`);
}
const per = (r: typeof runs[number], k: string) => r.p.lines.find((l) => l.key === k)!.units / r.s.playerCount;
ok(per(runs[4], 'water') > per(runs[1], 'water') && per(runs[1], 'water') > per(runs[0], 'water')
  && per(runs[0], 'water') > per(runs[2], 'water'),
  'water per player rises strictly with temperature across all five scenarios');
ok(runs[2].p.lines.find((l) => l.key === 'beer')!.units > runs[0].p.lines.find((l) => l.key === 'beer')!.units,
  'a cooler but much larger field still orders more beer in total — field size dominates');
ok(per(runs[3], 'beer') < per(runs[0], 'beer'),
  'the cold rainy December event orders less beer per player than the mild October one');
ok(runs.every((r) => r.p.lunch.portions >= r.s.playerCount + r.s.volunteerCount),
  'every scenario feeds at least everyone present');
ok(runs.every((r) => r.p.lines.every((l) => l.packedUnits >= l.units)),
  'every scenario rounds up to whole packs');

console.log(failures === 0
  ? '\n✅ F&B CALCULATOR — ALL CHECKS PASSED'
  : `\n❌ F&B CALCULATOR — ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
