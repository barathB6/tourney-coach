import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { draftOutreachEmail } from '@/lib/ai/sponsorOutreachDraft';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

export async function POST(req: NextRequest) {
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sponsor_id?: string; mode?: 'intro' | 'follow_up' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.sponsor_id) {
    return NextResponse.json({ error: 'sponsor_id required' }, { status: 400 });
  }

  // RLS scopes this to the organizer's own sponsors
  const { data: sponsor } = await supabase
    .from('sponsors')
    .select('id, company, contact_name, contact_title, status, last_touch, tournament_id, tier_id, sponsorship_tiers(name, price_cents, benefits)')
    .eq('id', body.sponsor_id)
    .single();
  if (!sponsor) {
    return NextResponse.json({ error: 'Sponsor not found' }, { status: 404 });
  }

  const { data: tournament } = await supabase
    .from('tournaments')
    .select('name, event_date, location_name, cause_org, cause_tagline, max_players, cause_story_full, cause_story')
    .eq('id', sponsor.tournament_id)
    .single();

  const tier = sponsor.sponsorship_tiers as unknown as { name: string; price_cents: number; benefits: string[] } | null;
  const organizerName = user.user_metadata?.full_name || user.user_metadata?.name || 'the organizer';
  const isFollowUp = body.mode === 'follow_up' || sponsor.status === 'no_reply';
  // Trim to the first paragraph or so — enough to give the AI a real, specific
  // detail to weave into the opening hook without dumping the whole story in.
  const causeStoryExcerpt = (tournament?.cause_story_full ?? tournament?.cause_story ?? '').split(/\n\n+/)[0]?.slice(0, 500) || null;

  try {
    const { subject, body: emailBody } = await draftOutreachEmail({
      company: sponsor.company,
      contactName: sponsor.contact_name,
      contactTitle: sponsor.contact_title,
      tierName: tier?.name ?? null,
      tierPriceCents: tier?.price_cents ?? null,
      tierBenefits: tier?.benefits ?? null,
      tournamentName: tournament?.name ?? null,
      eventDate: tournament?.event_date ?? null,
      locationName: tournament?.location_name ?? null,
      causeOrg: tournament?.cause_org ?? null,
      causeTagline: tournament?.cause_tagline ?? null,
      maxPlayers: tournament?.max_players ?? null,
      causeStoryExcerpt,
      organizerName,
      isFollowUp,
    });
    return NextResponse.json({ subject, body: emailBody });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'AI drafting failed' },
      { status: 503 },
    );
  }
}
