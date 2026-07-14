import { askClaude } from '@/lib/ai/anthropic';

export const OUTREACH_SYSTEM = `You are TourneyCoach's sponsorship outreach writer. You draft short, warm, effective sponsorship outreach emails for charity golf tournament organizers. Plain language, no corporate jargon, no exclamation-mark overload. The goal is a reply, not a hard close.

Rules:
- Subject line under 60 characters, specific to the business.
- Body under 180 words. Three short paragraphs max.
- Open with a genuine local hook connecting the business to the community or cause. If a cause story excerpt is provided, pull one concrete, specific detail from it (not a generic paraphrase) into the hook or the close — this is what makes the ask feel real instead of templated.
- Name the specific package, its price, and its two most valuable benefits.
- Close with a low-friction ask (a 10-minute call or a reply), never "let me know your thoughts".
- Write from the organizer's voice, first person.
- Never invent facts about the business.

Return ONLY the email in this exact format:
Subject: <subject line>

<body>`;

export interface OutreachDraftInput {
  company: string;
  contactName: string | null;
  contactTitle: string | null;
  tierName: string | null;
  tierPriceCents: number | null;
  tierBenefits: string[] | null;
  tournamentName: string | null;
  eventDate: string | null;
  locationName: string | null;
  causeOrg: string | null;
  causeTagline: string | null;
  maxPlayers: number | null;
  causeStoryExcerpt: string | null;
  organizerName: string;
  isFollowUp: boolean;
}

export function buildOutreachPrompt(input: OutreachDraftInput): string {
  return `Draft a ${input.isFollowUp ? 'polite follow-up email (they have not replied to a previous outreach)' : 'first-touch outreach email'} to this sponsorship prospect.

Prospect:
- Company: ${input.company}
- Contact: ${input.contactName || 'Unknown'}${input.contactTitle ? `, ${input.contactTitle}` : ''}

Package being offered:
- ${input.tierName ? `${input.tierName} — $${((input.tierPriceCents ?? 0) / 100).toLocaleString()}` : 'A sponsorship package (pick a sensible mid-tier framing)'}
- Benefits: ${input.tierBenefits?.length ? input.tierBenefits.join('; ') : 'standard signage and program recognition'}

Tournament:
- Name: ${input.tournamentName ?? 'our charity golf tournament'}
- Date: ${input.eventDate ? new Date(input.eventDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD'}
- Course: ${input.locationName ?? 'a local course'}
- Benefiting: ${input.causeOrg ?? input.causeTagline ?? 'a local cause'}
- Field: ${input.maxPlayers ?? 72} players (local golfers, business owners, and community leaders)
${input.causeStoryExcerpt ? `\nCause story (use a specific, real detail from this — not a generic paraphrase — as part of the hook or the ask):\n"${input.causeStoryExcerpt}"\n` : ''}
Organizer signing the email: ${input.organizerName}`;
}

export async function draftOutreachEmail(input: OutreachDraftInput): Promise<{ subject: string; body: string }> {
  const prompt = buildOutreachPrompt(input);
  const draft = await askClaude(OUTREACH_SYSTEM, prompt, 600);
  const match = draft.match(/^Subject:\s*(.+)\n+([\s\S]+)$/);
  return {
    subject: match ? match[1].trim() : `Sponsorship opportunity — ${input.tournamentName ?? 'charity golf tournament'}`,
    body: match ? match[2].trim() : draft,
  };
}
