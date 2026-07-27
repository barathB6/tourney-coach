// Unit checks for lib/tourneycircle. Run: npx tsx scripts/verify-tourneycircle.ts
import { expectedClicks, dollars, centroidOf, countWithinRadius, milesToMeters, isValidRadius, NOTIFICATION_COST_CENTS, type Member } from '../lib/tourneycircle';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d?: string) => { c ? pass++ : (fail++, console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`)); };

ok('cost is $29', dollars(NOTIFICATION_COST_CENTS) === '$29');
ok('~1 in 4 click (280→70)', expectedClicks(280) === 70, `${expectedClicks(280)}`);
ok('clicks floor', expectedClicks(347) === 86, `${expectedClicks(347)}`);
ok('0 matched → 0 clicks', expectedClicks(0) === 0);
ok('valid radius', isValidRadius(25) && !isValidRadius(30));

ok('centroid of none is null', centroidOf([]) === null);
const c = centroidOf([{ lat: 30, lng: -90 }, { lat: 32, lng: -92 }]);
ok('centroid averages', !!c && c.lat === 31 && c.lng === -91);

// Reference point ~ Beau Chêne area; two near, one far, one no-location.
const ref = { lat: 30.42, lng: -90.10 };
const near = (dLat: number) => ({ home_lat: 30.42 + dLat, home_lng: -90.10, member_type: 'individual' as const });
const members: Member[] = [
  near(0.05),                                  // ~3.5 mi — within 25
  { home_lat: 30.44, home_lng: -90.12, member_type: 'corporate' },  // within 25
  { home_lat: 31.9, home_lng: -90.10, member_type: 'individual' },  // ~100 mi — outside 25
  { home_lat: null, home_lng: null, member_type: 'coe' },           // unlocatable — excluded
];
const r25 = countWithinRadius(members, ref, 25);
ok('counts within 25 mi', r25.total === 2, `${r25.total}`);
ok('breakdown individual', r25.individual === 1, `${r25.individual}`);
ok('breakdown corporate', r25.corporate === 1);
ok('far member excluded', r25.total === 2);
ok('50 mi still excludes 100-mi member', countWithinRadius(members, ref, 50).total === 2);
ok('null reference → 0', countWithinRadius(members, null, 25).total === 0);
ok('miles→meters', Math.round(milesToMeters(25)) === 40234);

console.log(`\ntourneycircle: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
