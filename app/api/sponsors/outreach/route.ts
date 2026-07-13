import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { askClaude } from '@/lib/ai/anthropic';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

const SYSTEM = `You are TourneyCoach's sponsorship outreach writer. You draft short, warm, effective sponsorship outreach emails for charity golf tournament organizers. Plain language, no corporate jargon, no exclamation-mark overload. The goal is a reply, not a hard close.

Rules:
- Subject line under 60 characters, specific to the business.
- Body under 180 words. Three short paragraphs max.
- Open with a genuine local hook connecting the business to the community or cause.
- Name the specific package, its price, and its two most valuable benefits.
- Close with a low-friction ask (a 10-minute call or a reply), never "let me know your thoughts".
- Write from the organizer's voice, first person.
- Never invent facts about the business.

Return ONLY the email in this exact format:
Subject: <subject line>

<body>`;

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
    .select('name, event_date, location_name, cause_org, cause_tagline, max_players')
    .eq('id', sponsor.tournament_id)
    .single();

  const tier = sponsor.sponsorship_tiers as unknown as { name: string; price_cents: number; benefits: string[] } | null;
  const organizerName = user.user_metadata?.full_name || user.user_metadata?.name || 'the organizer';
  const isFollowUp = body.mode === 'follow_up' || sponsor.status === 'no_reply';

  const prompt = `Draft a ${isFollowUp ? 'polite follow-up email (they have not replied to a previous outreach)' : 'first-touch outreach email'} to this sponsorship prospect.

Prospect:
- Company: ${sponsor.company}
- Contact: ${sponsor.contact_name || 'Unknown'}${sponsor.contact_title ? `, ${sponsor.contact_title}` : ''}

Package being offered:
- ${tier ? `${tier.name} — $${(tier.price_cents / 100).toLocaleString()}` : 'A sponsorship package (pick a sensible mid-tier framing)'}
- Benefits: ${tier?.benefits?.length ? (tier.benefits as string[]).join('; ') : 'standard signage and program recognition'}

Tournament:
- Name: ${tournament?.name ?? 'our charity golf tournament'}
- Date: ${tournament?.event_date ? new Date(tournament.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD'}
- Course: ${tournament?.location_name ?? 'a local course'}
- Benefiting: ${tournament?.cause_org ?? tournament?.cause_tagline ?? 'a local cause'}
- Field: ${tournament?.max_players ?? 72} players (local golfers, business owners, and community leaders)

Organizer signing the email: ${organizerName}`;

  try {
    const draft = await askClaude(SYSTEM, prompt, 600);
    const match = draft.match(/^Subject:\s*(.+)\n+([\s\S]+)$/);
    return NextResponse.json({
      subject: match ? match[1].trim() : `Sponsorship opportunity — ${tournament?.name ?? 'charity golf tournament'}`,
      body: match ? match[2].trim() : draft,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'AI drafting failed' },
      { status: 503 },
    );
  }
}
