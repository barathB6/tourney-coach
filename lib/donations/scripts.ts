// Pre-written outreach scripts — for the phone call, not the email.
//
// Deliberately NOT AI-generated. A volunteer standing in a distributor's
// warehouse with their phone out needs the same words every time, available
// offline, with no latency and no chance of a model improvising a promise the
// tournament can't keep. The only dynamic part is the ask, which comes from
// the F&B calculator so the number on the call matches the number in the email.
//
// Every script follows the same shape, because it is the shape that works:
//   1. Who you are and who benefits — in one sentence.
//   2. The specific ask, said plainly, then STOP TALKING.
//   3. What they get back.
//   4. The permission to say a smaller yes.
//   5. One concrete next step.
//
// Step 2 is the one volunteers get wrong. The instinct is to keep talking to
// fill the silence, which talks the donor out of it. The scripts say so.

import type { FbPlan } from '@/lib/fb/calculator';
import { askFor, VENDOR_CATEGORIES, type VendorCategory } from '@/lib/donations/vendors';

export interface ScriptContext {
  tournamentName: string | null;
  causeOrg: string | null;
  eventDateLabel: string;
  locationName: string | null;
  playerCount: number | null;
  /** Null when the organizer has no name on their profile. */
  organizerName: string | null;
}

export interface OutreachScript {
  category: VendorCategory;
  label: string;
  emoji: string;
  /** One line on who to actually ask for at this kind of business. */
  whoToAsk: string;
  /** When in the week this call lands best. */
  whenToCall: string;
  lines: { step: string; say: string; note?: string }[];
  objections: { objection: string; response: string }[];
}

const WHO: Record<VendorCategory, { whoToAsk: string; whenToCall: string }> = {
  beer_wine_distributor: {
    whoToAsk: 'Ask for the market manager or the community relations contact — not the sales rep who covers bars.',
    whenToCall: 'Tuesday to Thursday, mid-morning. Mondays are route days.',
  },
  liquor_store: {
    whoToAsk: 'Ask for the owner by name. Independents decide on the spot; chains will send you to a regional form.',
    whenToCall: 'Weekday afternoons, well before the evening rush.',
  },
  food_supplier: {
    whoToAsk: 'Ask for the account manager who handles restaurants, not the front desk.',
    whenToCall: 'Early morning — most of them are done receiving by ten.',
  },
  restaurant: {
    whoToAsk: 'Ask for the owner or general manager. Never the person answering the phone at lunch.',
    whenToCall: 'Between 2pm and 4pm, the gap between services. This matters more than anything else on this page.',
  },
  coffee_shop: {
    whoToAsk: 'Ask for the owner. Independent shops say yes to community events far more than chains.',
    whenToCall: 'After the morning rush, around 10am.',
  },
  hole_in_one_insurance: {
    whoToAsk: 'These are agencies that quote by phone or online — you want a quote, not a donation.',
    whenToCall: 'Any weekday. Quote at least three weeks out so you can compare.',
  },
};

const OBJECTIONS: Record<VendorCategory, { objection: string; response: string }[]> = {
  beer_wine_distributor: [
    { objection: '"We\'ve used our donation budget for the year."',
      response: '"I understand. Can I send you the details for next year\'s budget cycle, and would a discount be possible this time instead?"' },
    { objection: '"State law limits what we can donate."',
      response: '"That makes sense — would selling it to us at cost work instead? We can also list you as a sponsor rather than a donor if that\'s cleaner."' },
    { objection: '"Send me an email."',
      response: '"I\'ll do that today. Who should I address it to, and is it worth a follow-up call next week?" — then actually get the name.' },
  ],
  liquor_store: [
    { objection: '"We get asked constantly."',
      response: '"I know you do, and I\'m not going to pretend we\'re special. We\'re local, it\'s one day, and we\'ll put your name on the cart."' },
    { objection: '"How much is this worth to me?"',
      response: '"Signage at the beverage cart, a mention at the awards, and roughly [player count] local people seeing your name for four hours."' },
  ],
  food_supplier: [
    { objection: '"We only donate through corporate."',
      response: '"Understood — can you point me at the form, and would you be willing to put a note on it? An internal endorsement moves those a lot."' },
    { objection: '"We can\'t cover all of that."',
      response: '"Then cover the part you can. Half the snacks would genuinely help, and I\'ll take the rest elsewhere."' },
  ],
  restaurant: [
    { objection: '"Our margins are too thin."',
      response: '"Completely fair. Would at-cost work? Or we can pay for food and you donate the labour — either way you get the credit."' },
    { objection: '"That\'s a lot of covers for one day."',
      response: '"It is. It\'s also [attendee count] people tasting your food who mostly live within ten miles of you."' },
  ],
  coffee_shop: [
    { objection: '"We\'re a small shop."',
      response: '"That\'s exactly why I called you rather than a chain. Even two airpots and a stack of cups would cover us."' },
  ],
  hole_in_one_insurance: [
    { objection: '"What\'s the prize value?"',
      response: 'Have the number ready before you call, along with the hole distance and the field size — they cannot quote without all three.' },
    { objection: '"We need a witness requirement."',
      response: '"We\'ll staff the hole with two volunteers for the whole shotgun. What else does the policy need?"' },
  ],
};

export function buildScript(
  category: VendorCategory, plan: FbPlan | null, ctx: ScriptContext,
): OutreachScript {
  const meta = VENDOR_CATEGORIES.find((c) => c.key === category)!;
  const ask = askFor(category, plan);
  const cause = ctx.causeOrg ?? 'a local cause';
  const event = ctx.tournamentName ?? 'our charity golf tournament';
  const where = ctx.locationName ? ` at ${ctx.locationName}` : '';
  const field = ctx.playerCount ?? 72;
  // A volunteer reads this aloud. "Hi, I'm the tournament committee" is not a
  // sentence a person can say, so with no name on file we drop the
  // introduction rather than substitute a phrase that looks like one.
  const intro = ctx.organizerName ? `I'm ${ctx.organizerName}. ` : '';
  // Likewise "on TBD" — better to omit the date than to say a placeholder.
  const when = ctx.eventDateLabel && ctx.eventDateLabel !== 'TBD' ? ` on ${ctx.eventDateLabel}` : '';

  const askLine = ask
    ? `"Here's what we need: ${ask}."`
    : `"We're still finalising quantities, but we're looking for help covering ${meta.covers.toLowerCase()}."`;

  return {
    category,
    label: meta.label,
    emoji: meta.emoji,
    ...WHO[category],
    lines: [
      {
        step: 'Open',
        say: `"Hi, ${intro}I'm running ${event}${when}${where}, and everything we raise goes to ${cause}. Do you have two minutes?"`,
        note: 'Say the cause in the first sentence. It is the only reason they keep listening.',
      },
      {
        step: 'The ask',
        say: askLine,
        note: 'Then stop. Do not fill the silence — the pause is what gets you a yes. Whoever speaks next is usually the one who concedes.',
      },
      {
        step: 'What they get',
        say: `"You'd get your name on signage at ${category === 'restaurant' || category === 'coffee_shop' ? 'the clubhouse' : 'the cart'}, a mention from the podium at the awards lunch, and a thank-you post. About ${field} players and their guests are there all day."`,
        note: 'Only promise these three. Do not invent tiers on the phone.',
      },
      {
        step: 'The smaller yes',
        say: `"And if that's too much, whatever portion you can do genuinely helps — I'd rather have half from you than nothing."`,
        note: 'This single line converts more calls than anything else in the script. Most vendors want to help but cannot cover the whole ask.',
      },
      {
        step: 'Close',
        say: `"What's the best email to send the details to? I'll follow up ${ask ? 'with the exact quantities' : 'once quantities are set'} today."`,
        note: 'Leave with an email address and a date. "I\'ll think about it" with no next step is a no.',
      },
      {
        step: 'If they say yes',
        say: `"That's brilliant, thank you. I'll email a confirmation today, and we'll send you an acknowledgement letter for your records after the event."`,
        note: 'Mention the acknowledgement letter — for a business donating goods, that is the part their accountant asks about.',
      },
    ],
    objections: OBJECTIONS[category] ?? [],
  };
}

/**
 * "The three calls every charity tournament needs to make" — the categories to
 * work first, in order. Beer, lunch and liquor are where the money actually is:
 * they are the biggest line items and the ones most likely to say yes.
 */
export const PRIORITY_CALLS: VendorCategory[] = ['beer_wine_distributor', 'restaurant', 'liquor_store'];

export function buildAllScripts(plan: FbPlan | null, ctx: ScriptContext): OutreachScript[] {
  // Priority three first, then the rest in catalogue order.
  const rest = VENDOR_CATEGORIES.map((c) => c.key).filter((k) => !PRIORITY_CALLS.includes(k));
  return [...PRIORITY_CALLS, ...rest].map((k) => buildScript(k, plan, ctx));
}
