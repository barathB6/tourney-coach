import { askClaude } from '@/lib/ai/anthropic';
import { formatEventDate } from '@/lib/formatEventDate';

// An in-kind donation ask is a different letter from a sponsorship pitch, and
// drafting it with the sponsorship prompt produces something subtly wrong.
// A sponsorship sells exposure for money. This asks a business to give away
// product it paid for — so the currency is the cause, the ask has to be a
// specific quantity the vendor can picture on a pallet, and the recognition
// offered is a thank-you rather than a package tier.
export const DONATION_SYSTEM = `You are TourneyCoach's in-kind donation writer. You draft short, warm, specific emails asking local businesses to donate product to a charity golf tournament. Plain language, no corporate jargon, no exclamation-mark overload. The goal is a reply, not a hard close.

Rules:
- Subject line under 60 characters, specific and concrete. Name the item if you can.
- Body under 170 words. Three short paragraphs max.
- Open with a genuine local hook connecting this business to the community or the cause. If a cause story excerpt is provided, pull one concrete, specific detail from it — not a generic paraphrase. That detail is what separates this from a form letter.
- State the exact ask, with the exact quantity you are given, in its own sentence. Never soften it into "any support you can offer" and never change the number.
- Offer recognition in proportion: signage at the relevant station, a mention at the awards ceremony, and social thanks. Do not promise anything else.
- Say plainly that a partial donation or a discount is welcome — most vendors cannot cover the whole thing, and saying so raises the reply rate.
- Close with a low-friction ask (a reply or a short call), never "let me know your thoughts".
- Write from the organizer's voice, first person.
- Never invent facts about the business, and never invent quantities, prices, or tax-deduction advice.

Return ONLY the email in this exact format:
Subject: <subject line>

<body>`;

export interface DonationDraftInput {
  company: string;
  contactName: string | null;
  categoryLabel: string;
  /** The concrete ask from the F&B calculator, e.g. "10 cases of beer for 72 players". */
  ask: string | null;
  tournamentName: string | null;
  eventDate: string | null;
  locationName: string | null;
  causeOrg: string | null;
  causeTagline: string | null;
  causeStoryExcerpt: string | null;
  playerCount: number | null;
  organizerName: string;
  isFollowUp: boolean;
}

export function buildDonationPrompt(input: DonationDraftInput): string {
  const date = formatEventDate(input.eventDate, { month: 'long', day: 'numeric', year: 'numeric' });

  return `Draft a ${input.isFollowUp
    ? 'brief, polite follow-up email (they have not replied to a first email; do not repeat it wholesale, and give them an easy way to say no)'
    : 'first-touch in-kind donation request'} to this local business.

Business:
- Name: ${input.company}
- Contact: ${input.contactName || 'Unknown — address the business generally rather than inventing a name'}
- Type: ${input.categoryLabel}

The ask:
${input.ask
  ? `- ${input.ask}\n- Use this quantity exactly as written. It came from a real calculation for this field size and the forecast weather.`
  : `- No quantity has been calculated yet. Ask qualitatively for support of the ${input.categoryLabel.toLowerCase()} portion of the event, and do NOT state any number.`}

Tournament:
- Name: ${input.tournamentName ?? 'our charity golf tournament'}
- Date: ${date}
- Course: ${input.locationName ?? 'a local course'}
- Benefiting: ${input.causeOrg ?? input.causeTagline ?? 'a local cause'}
- Field: ${input.playerCount ?? 72} players (local golfers, business owners, and community leaders)
${input.causeStoryExcerpt ? `\nCause story (use a specific, real detail from this as part of the hook or the close):\n"${input.causeStoryExcerpt}"\n` : ''}
Organizer signing the email: ${input.organizerName}`;
}

export async function draftDonationEmail(
  input: DonationDraftInput,
): Promise<{ subject: string; body: string }> {
  const draft = await askClaude(DONATION_SYSTEM, buildDonationPrompt(input), 600);
  const match = draft.match(/^Subject:\s*(.+)\n+([\s\S]+)$/);
  return {
    subject: match ? match[1].trim() : `Donation request — ${input.tournamentName ?? 'charity golf tournament'}`,
    body: match ? match[2].trim() : draft,
  };
}
