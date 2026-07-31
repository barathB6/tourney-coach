// Module 09 — Donation Solicitation: call scripts, acknowledgement letters,
// donor wall.
//
// The tax letter is the one with real-world consequences. A charity that
// assigns a dollar value to donated goods is doing the donor's job for them,
// and if the number is wrong it exposes the donor. So the checks below are
// mostly about what the letter must NOT say.
//
//   npx tsx scripts/verify-module09.ts
import { calculateFb } from '../lib/fb/calculator';
import { buildScript, buildAllScripts, PRIORITY_CALLS } from '../lib/donations/scripts';
import { buildTaxLetter, TAX_LETTER_DISCLAIMER } from '../lib/donations/taxLetter';
import { buildDonorWall } from '../lib/donations/donorWall';
import { VENDOR_CATEGORIES } from '../lib/donations/vendors';

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

const plan = calculateFb({
  playerCount: 72, volunteerCount: 12, temperatureF: 78,
  menu: ['Pulled pork', 'Mac and cheese'], shotgunAt: '2026-10-10T08:00:00Z',
});

const CTX = {
  tournamentName: 'St. Michael’s Cup',
  causeOrg: 'Monterey Youth Golf',
  eventDateLabel: 'October 10',
  locationName: 'Bayonet Black Horse',
  playerCount: 72,
  organizerName: 'Barath Balaji',
};

// ── Scripts ─────────────────────────────────────────────────────────────────
section('1. Call scripts');
const scripts = buildAllScripts(plan, CTX);
ok(scripts.length === VENDOR_CATEGORIES.length, 'every vendor category gets a script', `${scripts.length}`);
ok(scripts.slice(0, 3).map((s) => s.category).join(',') === PRIORITY_CALLS.join(','),
  'the three priority calls come first, in order', scripts.slice(0, 3).map((s) => s.category).join(', '));

const beerScript = buildScript('beer_wine_distributor', plan, CTX);
const beerAsk = beerScript.lines.find((l) => l.step === 'The ask')!;
ok(beerAsk.say.includes('10 cases'), 'the spoken ask carries the exact computed quantity', beerAsk.say);
ok(!!beerAsk.note && (beerAsk.note.includes('stop') || beerAsk.note.includes('silence')),
  'and tells the volunteer to stop talking after it — the single most common mistake');
ok(beerScript.lines[0].say.includes('Monterey Youth Golf'), 'the cause is named in the opening line');
ok(beerScript.lines[0].say.includes('October 10') && beerScript.lines[0].say.includes('Bayonet'),
  'with the real date and course');
ok(beerScript.lines.some((l) => l.step === 'The smaller yes'),
  'every script offers the partial-donation escape hatch');
ok(beerScript.objections.length > 0 && beerScript.whoToAsk.length > 0 && beerScript.whenToCall.length > 0,
  'and carries objection handling, who to ask for, and when to call');

// Without a plan, the script must not invent a number.
const noPlan = buildScript('beer_wine_distributor', null, CTX);
const noPlanAsk = noPlan.lines.find((l) => l.step === 'The ask')!;
ok(!/\d+\s+cases/.test(noPlanAsk.say), 'with no F&B plan the script states no quantity at all', noPlanAsk.say);
ok(scripts.every((s) => s.lines.every((l) => !/\[|\bTBD\b|undefined|null/.test(l.say))),
  'no script contains an unfilled placeholder or a stray null');

// Both of these shipped briefly and were caught only by looking at the live
// page: a volunteer cannot read "Hi, I'm the tournament committee" aloud, and
// "on TBD" is worse than saying no date at all.
const anon = buildScript('beer_wine_distributor', plan, { ...CTX, organizerName: null });
ok(!/I'm the tournament committee|I'm null|I'm \./.test(anon.lines[0].say),
  'with no organizer name the introduction is dropped, not filled with a phrase', anon.lines[0].say);
ok(anon.lines[0].say.startsWith('"Hi, I\'m running'), 'and the sentence still reads correctly');

const noDate = buildScript('beer_wine_distributor', plan, { ...CTX, eventDateLabel: 'TBD' });
ok(!noDate.lines[0].say.includes('TBD'), 'an unknown date is omitted rather than spoken as "on TBD"', noDate.lines[0].say);

// ── Tax letters ─────────────────────────────────────────────────────────────
section('2. Acknowledgement letters');
const letter = buildTaxLetter({
  charityLegalName: 'Monterey Youth Golf Foundation, Inc.',
  charityEin: '82-1234567',
  charityAddress: '14 Cannery Row, Monterey, CA 93940',
  tournamentName: CTX.tournamentName,
  eventDate: '2026-10-10',
  organizerName: 'Barath Balaji',
  company: 'Central Coast Beverage',
  contactName: 'Dana Whitfield',
  donationDescription: '10 cases of beer (240 cans)',
  receivedDate: '2026-10-10',
  benefitsProvided: 'signage at the beverage cart and a mention at the awards ceremony',
});

ok(letter.missing.length === 0, 'a complete input produces a letter with nothing missing');
ok(letter.body.includes('82-1234567'), 'the EIN appears');
ok(letter.body.includes('Monterey Youth Golf Foundation, Inc.'), 'the charity LEGAL name appears, not the tournament name');
ok(letter.body.includes('10 cases of beer'), 'the donated goods are described');
ok(letter.body.includes('October 10, 2026'), 'the received date is correct and not a day early',
  letter.body.split('\n').find((l) => l.includes('October')) ?? '');

// The critical negative checks.
ok(!/\$\s?\d/.test(letter.body), 'THE LETTER STATES NO DOLLAR VALUE for the donated goods');
ok(/responsibility of the donor/i.test(letter.body), 'and says valuation is the donor’s responsibility');
ok(/goods or services/i.test(letter.body), 'the goods-or-services statement is present');
ok(letter.body.includes('signage at the beverage cart'), 'and describes what was given in return');
ok(/501\(c\)\(3\)/.test(letter.body), 'the tax-exempt status is stated');

const noBenefits = buildTaxLetter({
  charityLegalName: 'X Foundation', charityEin: '82-1234567', charityAddress: 'A',
  tournamentName: 'T', eventDate: '2026-10-10', organizerName: 'B',
  company: 'C', contactName: null, donationDescription: 'snacks', receivedDate: null, benefitsProvided: null,
});
ok(/No goods or services were provided/i.test(noBenefits.body),
  'with nothing given in return, the letter says so explicitly rather than staying silent');

const incomplete = buildTaxLetter({
  charityLegalName: null, charityEin: null, charityAddress: null,
  tournamentName: 'T', eventDate: null, organizerName: 'B',
  company: 'C', contactName: null, donationDescription: '', receivedDate: null, benefitsProvided: null,
});
ok(incomplete.missing.length === 4, 'a bare input names all four missing pieces', incomplete.missing.join('; '));
ok(incomplete.body.includes('[EIN]') && incomplete.body.includes('[CHARITY LEGAL NAME]'),
  'and leaves loud placeholders rather than a plausible-looking blank');
ok(TAX_LETTER_DISCLAIMER.includes('not tax advice'), 'the disclaimer says plainly this is not tax advice');

// ── Donor wall ──────────────────────────────────────────────────────────────
section('3. Donor wall');
const wall = buildDonorWall([
  { company: 'Central Coast Beverage', category: 'beer_wine_distributor', status: 'committed', committedValueCents: 48_000, askSummary: '10 cases of beer' },
  { company: 'Abita Brewing', category: 'beer_wine_distributor', status: 'committed', committedValueCents: 96_000, askSummary: '20 cases of beer' },
  { company: "Smiley's BBQ", category: 'restaurant', status: 'committed', committedValueCents: null, askSummary: 'awards lunch for 89' },
  { company: 'Fleur de Lis', category: 'liquor_store', status: 'sent', committedValueCents: null, askSummary: null },
  { company: 'Someone Who Said No', category: 'coffee_shop', status: 'declined', committedValueCents: null, askSummary: null },
  { company: 'Mystery Donor', category: null, status: 'committed', committedValueCents: null, askSummary: null },
  { company: '   ', category: 'restaurant', status: 'committed', committedValueCents: null, askSummary: null },
], { tournamentName: CTX.tournamentName });

ok(wall.total === 4, 'only committed donors with a name appear', `${wall.total}`);
const names = wall.groups.flatMap((g) => g.donors.map((d) => d.name));
ok(!names.includes('Fleur de Lis'), 'a prospect still awaiting a reply is NOT on the printed wall');
ok(!names.includes('Someone Who Said No'), 'nor is a vendor who declined');
ok(!names.some((n) => n.trim() === ''), 'a blank company name is dropped rather than printed as an empty line');
const beerGroup = wall.groups.find((g) => g.key === 'beer_wine_distributor')!;
ok(beerGroup.donors[0].name === 'Abita Brewing',
  'inside a group, the larger contribution is listed first', beerGroup.donors.map((d) => d.name).join(' then '));
ok(wall.groups.some((g) => g.key === 'other' && g.donors.some((d) => d.name === 'Mystery Donor')),
  'a committed donor with no category is still thanked rather than silently dropped');
ok(wall.uncategorised.includes('Mystery Donor'), 'and is flagged so the organizer can categorise them');
ok(!/\$|\d{2,}0{2}/.test(wall.plainText), 'the printed wall carries no dollar figures', wall.plainText.slice(0, 60));
ok(wall.plainText.includes('ST. MICHAEL’S CUP'), 'the heading uses the tournament name');
ok(wall.inline.includes('and'), 'the one-line credit reads as a sentence', wall.inline);

const emptyWall = buildDonorWall([{ company: 'Nobody', category: 'restaurant', status: 'sent', committedValueCents: null, askSummary: null }]);
ok(emptyWall.total === 0 && emptyWall.plainText === '' && emptyWall.inline === '',
  'with no commitments the wall is genuinely empty, not a heading over nothing');

console.log(failures === 0
  ? '\n✅ MODULE 09 — ALL CHECKS PASSED'
  : `\n❌ MODULE 09 — ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
