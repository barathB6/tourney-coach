// Day 25 — Phase E privacy verification for the TourneyCircle aggregate layer.
//
// Asserts the disclosure-control invariant the patent architecture rests on:
// an organizer can never resolve an aggregate down to an individual. Run with
//   npx tsx scripts/verify-tourneycircle-privacy.ts
import {
  causeBreakdown, countWithinRadius, disclose, discloseLadder, membersWithinRadius,
  MIN_DISCLOSABLE_COUNT, RADIUS_OPTIONS, type Member,
} from '../lib/tourneycircle';

let failures = 0;
function check(name: string, pass: boolean, detail = '') {
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
}

const REF = { lat: 30.36, lng: -90.07 }; // Mandeville, LA
// ~1 mile north per 0.0145 deg latitude (1 deg lat ≈ 69 miles).
const atMiles = (mi: number) => ({ home_lat: REF.lat + mi * 0.0145, home_lng: REF.lng });

type M = Member & { cause_preferences?: string[] | null };
const member = (mi: number, type: Member['member_type'], causes: string[] = []): M => ({
  ...atMiles(mi), member_type: type, cause_preferences: causes,
});

console.log('\n== disclosure threshold ==');
check('a bucket of 1 is suppressed', disclose(1).suppressed);
check(`a bucket of ${MIN_DISCLOSABLE_COUNT - 1} is suppressed`, disclose(MIN_DISCLOSABLE_COUNT - 1).suppressed);
check(`a bucket of ${MIN_DISCLOSABLE_COUNT} is disclosed`, !disclose(MIN_DISCLOSABLE_COUNT).suppressed);
check('a suppressed bucket carries no residual value', disclose(3).value === 0, 'value must be 0, not the real count');
check('zero is suppressed too', disclose(0).suppressed, 'so "nobody here" and "one person here" look identical');

console.log('\n== differencing attack: isolate one person by narrowing radius ==');
// 6 players inside 15mi, plus exactly ONE between 15 and 25mi. An organizer who
// sees per-radius totals could subtract to learn that one person exists.
const differencing: M[] = [
  ...Array.from({ length: 6 }, () => member(5, 'individual')),
  member(20, 'individual'), // the lone target
];
const rawRings = RADIUS_OPTIONS.map((r) => countWithinRadius(differencing, REF, r).total);
const shownRings = discloseLadder(rawRings);
RADIUS_OPTIONS.forEach((r, i) =>
  console.log(`     ${r}mi: raw=${rawRings[i]} shown=${shownRings[i].suppressed ? '—' : shownRings[i].value}`));

// The attack: subtract any two DISCLOSED rungs. Only what the response actually
// contains counts — a suppressed rung gives the attacker nothing to subtract.
function isolatingPairs(shown: { value: number; suppressed: boolean }[]) {
  const visible = shown.map((s, i) => ({ i, ...s })).filter((s) => !s.suppressed);
  const leaks: string[] = [];
  for (let a = 0; a < visible.length; a++) {
    for (let b = a + 1; b < visible.length; b++) {
      const diff = visible[b].value - visible[a].value;
      if (diff > 0 && diff < MIN_DISCLOSABLE_COUNT) {
        leaks.push(`${RADIUS_OPTIONS[visible[a].i]}->${RADIUS_OPTIONS[visible[b].i]}=${diff}`);
      }
    }
  }
  return leaks;
}
const leaks = isolatingPairs(shownRings);
check(
  'no pair of disclosed radii can be differenced to a sub-threshold group',
  leaks.length === 0,
  leaks.length ? `LEAKS ${leaks.join(', ')}` : 'checked every disclosed pair, not just adjacent ones',
);

// Randomised sweep: many shapes of population, same invariant.
let sweepLeaks = 0;
for (let trial = 0; trial < 500; trial++) {
  const pop: M[] = [];
  const n = Math.floor(Math.random() * 40);
  for (let k = 0; k < n; k++) pop.push(member(Math.random() * 55, 'individual'));
  const shown = discloseLadder(RADIUS_OPTIONS.map((r) => countWithinRadius(pop, REF, r).total));
  if (isolatingPairs(shown).length) sweepLeaks++;
}
check('randomised sweep: 500 populations, no differencing leak', sweepLeaks === 0, `${sweepLeaks} leaking populations`);

console.log('\n== ladder rule specifics ==');
check('a lone rung below the floor is suppressed', discloseLadder([3])[0].suppressed);
check('equal consecutive rungs both disclose (they add nobody new)',
  discloseLadder([8, 8]).every((d) => !d.suppressed));
check('a +1 increment over a disclosed rung is suppressed',
  discloseLadder([8, 9])[1].suppressed, '9-8=1 would name a person');
check('a large increment discloses', !discloseLadder([8, 20])[1].suppressed);
check('suppression is not sticky — a later safe rung still discloses',
  !discloseLadder([8, 9, 30])[2].suppressed, '30-8=22, safe against the last DISCLOSED rung');

console.log('\n== cause breakdown ==');
const causal: M[] = [
  ...Array.from({ length: 7 }, () => member(5, 'individual', ['youth education'])),
  ...Array.from({ length: 5 }, () => member(5, 'individual', ['veterans'])),
  // One person with a hyper-specific cause — as identifying as a name.
  member(5, 'individual', ['junior hockey in mandeville']),
  member(5, 'individual', ['rare disease research']),
];
const causes = causeBreakdown(causal);
console.log('    ', JSON.stringify(causes));
check('common causes are reported', causes.some((c) => c.cause === 'youth education' && c.count === 7));
check(
  'a one-person cause is never listed',
  !causes.some((c) => c.cause === 'junior hockey in mandeville'),
  'a rare cause identifies as surely as a name',
);
check(
  'rare causes folded into "other" only when the fold itself clears the bar',
  !causes.some((c) => c.cause === 'other'),
  '2 rare members < threshold, so no "other" row either',
);

// With enough rare causes the fold is safe to show.
const manyRare: M[] = Array.from({ length: 6 }, (_, i) => member(5, 'individual', [`rare-cause-${i}`]));
const folded = causeBreakdown(manyRare);
check('an "other" bucket appears once it clears the threshold', folded.some((c) => c.cause === 'other' && c.count === 6));
check('…and the rare causes themselves stay hidden', !folded.some((c) => c.cause.startsWith('rare-cause')));

console.log('\n== no individual data in the aggregate surface ==');
const sample: M[] = [member(5, 'individual', ['youth education']), member(40, 'corporate')];
const agg = countWithinRadius(sample, REF, 25);
const aggKeys = Object.keys(agg);
check(
  'countWithinRadius returns only numeric counts',
  aggKeys.every((k) => typeof (agg as unknown as Record<string, unknown>)[k] === 'number'),
  aggKeys.join(', '),
);
const serialized = JSON.stringify({ matched: agg, byCause: causeBreakdown(membersWithinRadius(sample, REF, 25)) });
for (const leak of ['lat', 'lng', 'home_', 'email', 'player_profile_id', 'name']) {
  check(`serialized aggregate contains no "${leak}"`, !serialized.includes(leak));
}

console.log('\n== radius matching sanity ==');
check('player at 5mi counts inside 15mi', countWithinRadius([member(5, 'individual')], REF, 15).total === 1);
check('player at 40mi excluded from 25mi', countWithinRadius([member(40, 'individual')], REF, 25).total === 0);
check('player at 40mi included in 50mi', countWithinRadius([member(40, 'individual')], REF, 50).total === 1);
check('no reference point yields zero, not a crash', countWithinRadius([member(5, 'individual')], null, 25).total === 0);
check('member without a home location is never matched',
  countWithinRadius([{ home_lat: null, home_lng: null, member_type: 'individual' }], REF, 50).total === 0);

console.log(failures === 0 ? '\nPASS — all privacy assertions hold\n' : `\nFAIL — ${failures} assertion(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
