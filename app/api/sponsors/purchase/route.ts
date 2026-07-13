import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPaymentProcessor } from '@/lib/payments';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Public endpoint: a sponsor self-purchases a package from the microsite.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tournament_id, tier_id, company, contact_name, email, phone, website, return_url } = body;

    if (!tournament_id || !tier_id || !company?.trim() || !email?.trim()) {
      return NextResponse.json({ error: 'tournament_id, tier_id, company, and email are required' }, { status: 400 });
    }

    const supabase = getSupabase();

    const { data: tournament } = await supabase
      .from('tournaments')
      .select('id, name, status')
      .eq('id', tournament_id)
      .in('status', ['published', 'live'])
      .single();
    if (!tournament) {
      return NextResponse.json({ error: 'Tournament not open for sponsorship' }, { status: 404 });
    }

    const { data: tier } = await supabase
      .from('sponsorship_tiers')
      .select('id, name, price_cents, quantity')
      .eq('id', tier_id)
      .eq('tournament_id', tournament_id)
      .single();
    if (!tier) {
      return NextResponse.json({ error: 'Sponsorship package not found' }, { status: 404 });
    }

    // Check availability (paid + pending count against quantity)
    if (tier.quantity != null) {
      const { count } = await supabase
        .from('sponsors')
        .select('id', { count: 'exact', head: true })
        .eq('tier_id', tier.id)
        .in('status', ['paid', 'pending', 'invoiced', 'verbal']);
      if ((count ?? 0) >= tier.quantity) {
        return NextResponse.json({ error: 'This sponsorship level is sold out' }, { status: 409 });
      }
    }

    const { data: sponsor, error: insErr } = await supabase
      .from('sponsors')
      .insert({
        tournament_id,
        tier_id: tier.id,
        company: company.trim(),
        contact_name: contact_name?.trim() || null,
        email: email.trim(),
        phone: phone?.trim() || null,
        website: website?.trim() || null,
        status: 'pending',
        amount_cents: tier.price_cents,
        source: 'self_purchase',
        last_touch: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (insErr || !sponsor) {
      console.error('Sponsor insert error:', insErr);
      return NextResponse.json({ error: 'Could not create sponsorship' }, { status: 500 });
    }

    // Create a payment session; merchantReference "sponsor:<id>" routes the webhook
    try {
      const processor = await getPaymentProcessor();
      const session = await processor.createSession({
        registrationId: `sponsor:${sponsor.id}`,
        amountCents: tier.price_cents,
        currency: 'USD',
        description: `${tier.name} sponsorship — ${tournament.name}`,
        returnUrl: return_url ?? `${process.env.NEXT_PUBLIC_APP_URL}/`,
        shopperEmail: email.trim(),
        shopperName: contact_name?.trim() || company.trim(),
      });
      return NextResponse.json({ sponsor_id: sponsor.id, payment: session }, { status: 201 });
    } catch (payErr) {
      // Payment processor unavailable — keep the commitment, organizer invoices manually
      console.error('Sponsor payment session error:', payErr);
      await supabase.from('sponsors').update({ status: 'invoiced' }).eq('id', sponsor.id);
      return NextResponse.json({ sponsor_id: sponsor.id, payment: null }, { status: 201 });
    }
  } catch (err) {
    console.error('Sponsor purchase error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

// Public: list tiers with sold counts for the microsite sales page
export async function GET(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get('tournament_id');
  if (!tournamentId) {
    return NextResponse.json({ error: 'tournament_id required' }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: tiers } = await supabase
    .from('sponsorship_tiers')
    .select('id, name, label, price_cents, benefits, quantity, highlight, sort_order')
    .eq('tournament_id', tournamentId)
    .order('sort_order', { ascending: true });

  const { data: taken } = await supabase
    .from('sponsors')
    .select('tier_id')
    .eq('tournament_id', tournamentId)
    .in('status', ['paid', 'pending', 'invoiced', 'verbal']);

  const counts: Record<string, number> = {};
  for (const s of taken ?? []) {
    if (s.tier_id) counts[s.tier_id] = (counts[s.tier_id] ?? 0) + 1;
  }

  return NextResponse.json(
    (tiers ?? []).map(t => ({ ...t, sold: counts[t.id] ?? 0 })),
  );
}
