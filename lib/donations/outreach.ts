// Vendor donation outreach: drafting, sending, tracking, and the follow-up
// cadence.
//
// The tracking columns the spec names — sent / opened / responded / committed
// / declined — are one `status` field rather than five booleans, because they
// are genuinely a sequence and five booleans permit nonsense states like
// "opened but never sent". Opens arrive from the SendGrid event webhook,
// replies from the inbound-parse webhook, and commit/decline from the
// organizer. All three write the same field.

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadFbPlan } from '@/lib/fb/plan';
import { askFor, categoryMeta, VENDOR_CATEGORIES, type VendorCategory } from '@/lib/donations/vendors';
import { draftDonationEmail } from '@/lib/ai/donationOutreachDraft';
import { sendDonationOutreachEmail } from '@/lib/email/donationOutreach';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

/** Days between automatic follow-ups. */
export const FOLLOWUP_DUE_DAYS = 7;
/** Follow-ups after the first email. Two, then we stop chasing. */
export const MAX_FOLLOWUPS = 2;

/** Statuses that mean the vendor has engaged — the cadence stops here. */
export const RESOLVED = new Set(['responded', 'committed', 'declined']);
/** Statuses the cadence still chases. */
export const CHASEABLE = ['sent', 'opened'];

export interface ProspectRow {
  id: string;
  company: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  category: string | null;
  categoryLabel: string | null;
  status: string;
  askSummary: string | null;
  draftSubject: string | null;
  draftBody: string | null;
  sentAt: string | null;
  followUpCount: number;
  lastContactAt: string | null;
  openedAt: string | null;
  emailOpens: number;
  respondedAt: string | null;
  replySnippet: string | null;
  committedAt: string | null;
  committedValueCents: number | null;
  declinedAt: string | null;
  /** When the next automatic follow-up becomes due; null when the cadence is done. */
  nextFollowUpAt: string | null;
}

const iso = (v: unknown) => (typeof v === 'string' ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function nextFollowUpAt(row: { status: string; follow_up_count?: unknown; last_contact_at?: unknown }): string | null {
  if (!CHASEABLE.includes(row.status)) return null;
  if (int(row.follow_up_count) >= MAX_FOLLOWUPS) return null;
  const last = iso(row.last_contact_at);
  if (!last) return null;
  const t = Date.parse(last);
  if (Number.isNaN(t)) return null;
  return new Date(t + FOLLOWUP_DUE_DAYS * 86_400_000).toISOString();
}

export interface DonationsSnapshot {
  prospects: ProspectRow[];
  summary: {
    total: number;
    sent: number;
    opened: number;
    responded: number;
    committed: number;
    declined: number;
    committedValueCents: number;
    /** Categories with no committed vendor yet. */
    uncovered: { key: string; label: string; covers: string; suggestedProspects: number }[];
  };
  /** What each category should be asked for, given the current F&B plan. */
  asks: { key: VendorCategory; label: string; covers: string; ask: string | null; suggestedProspects: number }[];
  hasFbPlan: boolean;
}

export async function loadDonations(service: DB, tournamentId: string): Promise<DonationsSnapshot> {
  const [{ data: rows }, planRecord] = await Promise.all([
    service.from('donation_prospects').select('*').eq('tournament_id', tournamentId).order('created_at', { ascending: false }),
    loadFbPlan(service, tournamentId),
  ]);

  const plan = planRecord?.plan ?? null;

  const prospects: ProspectRow[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    company: (r.company as string | null) ?? (r.name as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? (r.name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    category: (r.category as string | null) ?? null,
    categoryLabel: categoryMeta((r.category as string) ?? '')?.label ?? null,
    status: (r.status as string) ?? 'prospect',
    askSummary: (r.ask_summary as string | null) ?? null,
    draftSubject: (r.draft_subject as string | null) ?? null,
    draftBody: (r.draft_body as string | null) ?? null,
    sentAt: iso(r.sent_at),
    followUpCount: int(r.follow_up_count),
    lastContactAt: iso(r.last_contact_at),
    openedAt: iso(r.opened_at),
    emailOpens: int(r.email_opens),
    respondedAt: iso(r.responded_at),
    replySnippet: (r.reply_snippet as string | null) ?? null,
    committedAt: iso(r.committed_at),
    committedValueCents: typeof r.committed_value_cents === 'number' ? r.committed_value_cents : null,
    declinedAt: iso(r.declined_at),
    nextFollowUpAt: nextFollowUpAt({
      status: (r.status as string) ?? 'prospect',
      follow_up_count: r.follow_up_count,
      last_contact_at: r.last_contact_at,
    }),
  }));

  const count = (s: string) => prospects.filter((p) => p.status === s).length;
  const committedCats = new Set(prospects.filter((p) => p.status === 'committed').map((p) => p.category));

  return {
    prospects,
    summary: {
      total: prospects.length,
      // "Sent" means outreach has gone out — an opened or responded prospect
      // was also sent, so this is cumulative rather than a bucket count.
      sent: prospects.filter((p) => p.status !== 'prospect').length,
      opened: prospects.filter((p) => ['opened', 'responded', 'committed', 'declined'].includes(p.status) && p.openedAt).length,
      responded: count('responded'),
      committed: count('committed'),
      declined: count('declined'),
      committedValueCents: prospects
        .filter((p) => p.status === 'committed')
        .reduce((n, p) => n + (p.committedValueCents ?? 0), 0),
      uncovered: VENDOR_CATEGORIES.filter((c) => !committedCats.has(c.key))
        .map((c) => ({ key: c.key, label: c.label, covers: c.covers, suggestedProspects: c.suggestedProspects })),
    },
    asks: VENDOR_CATEGORIES.map((c) => ({
      key: c.key, label: c.label, covers: c.covers,
      ask: askFor(c.key, plan),
      suggestedProspects: c.suggestedProspects,
    })),
    hasFbPlan: !!plan,
  };
}

async function draftContext(service: DB, tournamentId: string) {
  const { data: t } = await service.from('tournaments')
    .select('name, event_date, location_name, cause_org, cause_tagline, cause_story_short, cause_story_medium, organizer_id')
    .eq('id', tournamentId).maybeSingle();
  const planRecord = await loadFbPlan(service, tournamentId);
  let organizerName = 'The tournament committee';
  let organizerEmail: string | null = null;
  if (t?.organizer_id) {
    const { data: prof } = await service.from('profiles')
      .select('full_name, email').eq('id', t.organizer_id as string).maybeSingle();
    if (prof?.full_name) organizerName = prof.full_name as string;
    organizerEmail = (prof?.email as string | null) ?? null;
  }
  return { t, planRecord, organizerName, organizerEmail };
}

/** Generate (and store) an AI draft for one prospect. */
export async function draftForProspect(
  service: DB, tournamentId: string, prospectId: string, isFollowUp = false,
): Promise<{ subject: string; body: string; ask: string | null }> {
  const { data: p } = await service.from('donation_prospects')
    .select('*').eq('id', prospectId).eq('tournament_id', tournamentId).maybeSingle();
  if (!p) throw new Error('That prospect is not part of this tournament.');

  const { t, planRecord, organizerName } = await draftContext(service, tournamentId);
  const category = (p.category as VendorCategory | null);
  const meta = category ? categoryMeta(category) : null;
  const ask = category ? askFor(category, planRecord?.plan ?? null) : null;

  const draft = await draftDonationEmail({
    company: (p.company as string | null) ?? (p.name as string | null) ?? 'your business',
    contactName: (p.contact_name as string | null) ?? null,
    categoryLabel: meta?.label ?? 'Local business',
    ask,
    tournamentName: (t?.name as string | null) ?? null,
    eventDate: (t?.event_date as string | null) ?? null,
    locationName: (t?.location_name as string | null) ?? null,
    causeOrg: (t?.cause_org as string | null) ?? null,
    causeTagline: (t?.cause_tagline as string | null) ?? null,
    causeStoryExcerpt: (t?.cause_story_short as string | null) ?? (t?.cause_story_medium as string | null) ?? null,
    playerCount: planRecord?.plan?.inputs.playerCount ?? planRecord?.livePlayerCount ?? null,
    organizerName,
    isFollowUp,
  });

  await service.from('donation_prospects').update({
    draft_subject: draft.subject,
    draft_body: draft.body,
    ask_summary: ask,
    draft_generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', prospectId);

  return { ...draft, ask };
}

/**
 * Send outreach to one prospect.
 *
 * Claim-before-send: the log row is inserted first, so the unique index on
 * (prospect_id, follow_up_number) makes a concurrent second attempt fail on
 * insert rather than put a second email in the vendor's inbox. If the send
 * then fails, the row is marked with the error instead of being deleted —
 * a failed attempt is history too, and deleting it would let the next run
 * retry forever.
 */
export async function sendDonationOutreach(
  service: DB,
  tournamentId: string,
  prospectId: string,
  opts: { subject?: string; body?: string; isFollowUp?: boolean } = {},
): Promise<{ ok: boolean; error?: string; followUpNumber: number }> {
  const { data: p } = await service.from('donation_prospects')
    .select('*').eq('id', prospectId).eq('tournament_id', tournamentId).maybeSingle();
  if (!p) return { ok: false, error: 'That prospect is not part of this tournament.', followUpNumber: -1 };

  const email = (p.email as string | null)?.trim();
  if (!email) return { ok: false, error: 'That prospect has no email address.', followUpNumber: -1 };

  const isFollowUp = opts.isFollowUp ?? (p.status as string) !== 'prospect';
  const followUpNumber = isFollowUp ? int(p.follow_up_count) + 1 : 0;

  let subject = opts.subject?.trim();
  let body = opts.body?.trim();
  if (!subject || !body) {
    const drafted = await draftForProspect(service, tournamentId, prospectId, isFollowUp);
    subject = subject || drafted.subject;
    body = body || drafted.body;
  }

  // Claim the slot before sending.
  const { data: claim, error: claimErr } = await service.from('donation_outreach_log').insert({
    prospect_id: prospectId,
    tournament_id: tournamentId,
    method: 'email',
    direction: 'outbound',
    outcome: 'sending',
    subject,
    body,
    follow_up_number: followUpNumber,
    contacted_at: new Date().toISOString(),
  }).select('id').single();

  if (claimErr || !claim) {
    // 23505 means another run already claimed this exact attempt.
    if (claimErr?.code === '23505') {
      return { ok: false, error: 'That outreach has already been sent.', followUpNumber };
    }
    return { ok: false, error: 'Could not record the outreach — run migration 041.', followUpNumber };
  }

  const { organizerName, organizerEmail } = await draftContext(service, tournamentId);

  try {
    const { messageId } = await sendDonationOutreachEmail({
      to: email,
      toName: (p.contact_name as string | null) ?? (p.company as string | null) ?? null,
      subject: subject!,
      bodyText: body!,
      organizerName,
      organizerEmail,
      prospectId,
    });

    const now = new Date().toISOString();
    await service.from('donation_outreach_log')
      .update({ outcome: 'sent', message_id: messageId ?? null }).eq('id', claim.id as string);
    await service.from('donation_prospects').update({
      status: (p.status as string) === 'prospect' ? 'sent' : p.status,
      sent_at: (p.sent_at as string | null) ?? now,
      last_contact_at: now,
      follow_up_count: followUpNumber,
      updated_at: now,
    }).eq('id', prospectId);

    return { ok: true, followUpNumber };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed';
    await service.from('donation_outreach_log')
      .update({ outcome: 'failed', error: message.slice(0, 500) }).eq('id', claim.id as string);
    return { ok: false, error: message, followUpNumber };
  }
}

/**
 * The 7-day cadence. Runs daily; sends to everyone whose last contact was at
 * least FOLLOWUP_DUE_DAYS ago, who has not engaged, and who is under the cap.
 *
 * Daily rather than hourly because Vercel's Hobby plan only permits daily
 * crons. That is a real constraint, not an oversight, and it is harmless here:
 * a 7-day cadence does not care which hour of day 7 it fires.
 */
export async function runDonationFollowups(
  service: DB, now = new Date(),
): Promise<{ considered: number; sent: number; failed: number; details: { prospectId: string; ok: boolean; error?: string }[] }> {
  const cutoff = new Date(now.getTime() - FOLLOWUP_DUE_DAYS * 86_400_000).toISOString();

  const { data: due } = await service.from('donation_prospects')
    .select('id, tournament_id, status, follow_up_count, last_contact_at, email')
    .in('status', CHASEABLE)
    .lt('follow_up_count', MAX_FOLLOWUPS)
    .lte('last_contact_at', cutoff)
    .not('email', 'is', null)
    .limit(200);

  const details: { prospectId: string; ok: boolean; error?: string }[] = [];
  let sent = 0, failed = 0;

  for (const p of due ?? []) {
    const res = await sendDonationOutreach(service, p.tournament_id as string, p.id as string, { isFollowUp: true });
    if (res.ok) sent++; else failed++;
    details.push({ prospectId: p.id as string, ok: res.ok, error: res.error });
  }

  return { considered: (due ?? []).length, sent, failed, details };
}
