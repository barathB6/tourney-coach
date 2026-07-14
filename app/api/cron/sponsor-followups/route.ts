import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { draftOutreachEmail } from '@/lib/ai/sponsorOutreachDraft';
import { sendSponsorOutreachEmail } from '@/lib/email/sponsorOutreach';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const FOLLOWUP_DUE_DAYS = 7;
const MAX_FOLLOWUPS = 2;

// Runs daily via Vercel Cron (see vercel.json). Finds prospects still sitting
// at "contacted" with no status change for 7+ days and sends one AI-drafted
// follow-up, capped at 2 attempts total. Stops automatically the moment the
// organizer (or a webhook) moves status away from "contacted" — e.g. to
// verbal/invoiced/paid/declined on a reply, or "no_reply" once attempts run
// out — since the query below only ever matches "contacted" rows.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - FOLLOWUP_DUE_DAYS * 86400_000).toISOString();

  const { data: due, error } = await supabase
    .from('sponsors')
    .select('id, company, contact_name, contact_title, email, follow_up_count, tournament_id, tier_id, sponsorship_tiers(name, price_cents, benefits)')
    .eq('status', 'contacted')
    .lt('follow_up_count', MAX_FOLLOWUPS)
    .lte('outreach_sent_at', cutoff)
    .not('email', 'is', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: { sponsorId: string; company: string; ok: boolean; error?: string }[] = [];

  for (const sponsor of due ?? []) {
    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('name, event_date, location_name, cause_org, cause_tagline, max_players, cause_story_full, cause_story, organizer_id')
        .eq('id', sponsor.tournament_id)
        .single();
      if (!tournament) throw new Error('Tournament not found');

      const { data: organizerUser } = await supabase.auth.admin.getUserById(tournament.organizer_id);
      const organizerName = organizerUser?.user?.user_metadata?.full_name || organizerUser?.user?.user_metadata?.name || 'Your organizer';
      const organizerEmail = organizerUser?.user?.email ?? null;

      const tier = sponsor.sponsorship_tiers as unknown as { name: string; price_cents: number; benefits: string[] } | null;
      const causeStoryExcerpt = (tournament.cause_story_full ?? tournament.cause_story ?? '').split(/\n\n+/)[0]?.slice(0, 500) || null;

      const { subject, body } = await draftOutreachEmail({
        company: sponsor.company,
        contactName: sponsor.contact_name,
        contactTitle: sponsor.contact_title,
        tierName: tier?.name ?? null,
        tierPriceCents: tier?.price_cents ?? null,
        tierBenefits: tier?.benefits ?? null,
        tournamentName: tournament.name,
        eventDate: tournament.event_date,
        locationName: tournament.location_name,
        causeOrg: tournament.cause_org,
        causeTagline: tournament.cause_tagline,
        maxPlayers: tournament.max_players,
        causeStoryExcerpt,
        organizerName,
        isFollowUp: true,
      });

      const { messageId } = await sendSponsorOutreachEmail({
        to: sponsor.email!,
        toName: sponsor.contact_name,
        subject,
        bodyText: body,
        organizerName,
        organizerEmail,
        sponsorId: sponsor.id,
      });

      const nextCount = sponsor.follow_up_count + 1;
      const now = new Date().toISOString();
      await supabase
        .from('sponsors')
        .update({
          // After the 2nd follow-up with still no response, stop the cadence
          // for good by moving to the terminal "no_reply" state.
          status: nextCount >= MAX_FOLLOWUPS ? 'no_reply' : 'contacted',
          follow_up_count: nextCount,
          outreach_sent_at: now,
          last_touch: now,
          sendgrid_message_id: messageId ?? null,
        })
        .eq('id', sponsor.id);

      results.push({ sponsorId: sponsor.id, company: sponsor.company, ok: true });
    } catch (err) {
      results.push({ sponsorId: sponsor.id, company: sponsor.company, ok: false, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }

  return NextResponse.json({ processed: results.length, results });
}
