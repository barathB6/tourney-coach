// Donation acknowledgement letters for in-kind vendor donations.
//
// The one thing that must not be got wrong here: **the charity does not state
// a value for donated goods.** For non-cash contributions the donor determines
// fair market value; a charity that writes "$480 of beer" on a letter is doing
// the donor's job for them and, if the number is wrong, doing them harm. So
// this letter *describes* what was received — "10 cases of beer" — and says
// explicitly that valuation is the donor's responsibility.
//
// The other required pieces of a contemporaneous written acknowledgement:
//   - the charity's legal name (and, in practice, its EIN)
//   - a description of the property, without a value
//   - a statement of whether any goods or services were given in return, and
//     a description of them if so
//   - the date received
//
// Everything here is generated from what the organizer entered. It is a
// well-formed letter, not tax advice, and it says so — an organizer should
// still run their template past whoever files their return.

import { formatEventDate } from '@/lib/formatEventDate';

export interface TaxLetterInput {
  /** The 501(c)(3)'s legal name — not the tournament's name. */
  charityLegalName: string | null;
  charityEin: string | null;
  charityAddress: string | null;
  tournamentName: string | null;
  eventDate: string | null;
  organizerName: string;
  organizerTitle?: string | null;
  /** The vendor. */
  company: string;
  contactName: string | null;
  /** What they actually gave, in the organizer's words. */
  donationDescription: string;
  receivedDate: string | null;
  /**
   * What the tournament gave back. Signage and a podium mention are the usual
   * answer; naming them is required, and pretending nothing was given is worse
   * than describing it.
   */
  benefitsProvided: string | null;
}

export interface TaxLetter {
  subject: string;
  body: string;
  /** Things the organizer must fix before this letter is usable. */
  missing: string[];
}

export function buildTaxLetter(input: TaxLetterInput): TaxLetter {
  const missing: string[] = [];
  if (!input.charityLegalName) missing.push('the charity\'s legal name');
  if (!input.charityEin) missing.push('the charity\'s EIN');
  if (!input.charityAddress) missing.push('the charity\'s mailing address');
  if (!input.donationDescription.trim()) missing.push('a description of what was donated');

  const charity = input.charityLegalName ?? '[CHARITY LEGAL NAME]';
  const ein = input.charityEin ?? '[EIN]';
  const address = input.charityAddress ?? '[CHARITY ADDRESS]';
  const received = formatEventDate(input.receivedDate ?? input.eventDate, { month: 'long', day: 'numeric', year: 'numeric' });
  const eventLabel = input.tournamentName ?? 'our charity golf tournament';
  const greeting = input.contactName ? `Dear ${input.contactName},` : `Dear ${input.company},`;

  // The benefits paragraph is not optional. If nothing was given in return we
  // must say that explicitly; if something was, we must describe it.
  const benefitsParagraph = input.benefitsProvided?.trim()
    ? `In return for your contribution, ${charity} provided the following: ${input.benefitsProvided.trim()}. No other goods or services were provided in exchange for your contribution.`
    : `No goods or services were provided by ${charity} in exchange for your contribution.`;

  const body = [
    `${charity}`,
    `${address}`,
    `EIN: ${ein}`,
    '',
    received,
    '',
    `${input.company}`,
    input.contactName ? `Attn: ${input.contactName}` : '',
    '',
    greeting,
    '',
    `Thank you for your generous in-kind contribution to ${eventLabel}. On ${received}, ${charity} received the following donated goods from ${input.company}:`,
    '',
    `    ${input.donationDescription.trim() || '[DESCRIPTION OF DONATED GOODS]'}`,
    '',
    benefitsParagraph,
    '',
    `In accordance with IRS requirements for non-cash contributions, this acknowledgement describes the property received but does not assign it a value. Determining the fair market value of donated goods is the responsibility of the donor. Please retain this letter for your records.`,
    '',
    `${charity} is a tax-exempt organization under section 501(c)(3) of the Internal Revenue Code. Contributions may be deductible to the extent permitted by law.`,
    '',
    `Your support put this tournament on. Thank you.`,
    '',
    'Sincerely,',
    '',
    '',
    input.organizerName,
    input.organizerTitle || `${eventLabel}`,
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '' && i > 0)).join('\n');

  return {
    subject: `Thank you — donation acknowledgement from ${charity}`,
    body,
    missing,
  };
}

/** The disclaimer the UI must show alongside every generated letter. */
export const TAX_LETTER_DISCLAIMER =
  'This is a formatted acknowledgement letter, not tax advice. It deliberately does not state a value for donated goods — that is the donor\'s determination. Have your treasurer or accountant approve the template once before you send the first one.';
