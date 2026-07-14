import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendSponsorConfirmationEmail } from '@/lib/email/sponsorConfirmation';
import { getPublicAppUrl } from '@/lib/publicUrl';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

// Marks a sponsor paid outside the Adyen flow (check, cash, bank transfer)
// and sends the same confirmation + logo-prompt email the card path sends —
// recognition automation should trigger the same way regardless of how the
// money actually arrived.
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // RLS scopes this update to the organizer's own sponsors
  const { data: sponsor, error } = await supabase
    .from('sponsors')
    .update({ status: 'paid', last_touch: new Date().toISOString() })
    .eq('id', id)
    .select('id, company, contact_name, email, amount_cents, logo_url, tournament_id, sponsorship_tiers(name), tournaments(name, slug, event_date, location_name)')
    .single();

  if (error || !sponsor) {
    return NextResponse.json({ error: error?.message ?? 'Sponsor not found' }, { status: 404 });
  }

  if (sponsor.email) {
    const tier = sponsor.sponsorship_tiers as unknown as { name: string } | null;
    const tournament = sponsor.tournaments as unknown as { name: string; slug: string; event_date: string; location_name: string | null } | null;
    if (tournament) {
      const appUrl = getPublicAppUrl();
      sendSponsorConfirmationEmail({
        contactEmail: sponsor.email,
        contactName: sponsor.contact_name,
        company: sponsor.company,
        tierName: tier?.name ?? 'Sponsorship',
        amountCents: sponsor.amount_cents ?? 0,
        tournamentName: tournament.name,
        eventDate: tournament.event_date,
        locationName: tournament.location_name,
        logoUploadUrl: sponsor.logo_url ? null : `${appUrl}/microsite/${tournament.slug}/sponsor/${sponsor.id}/logo`,
      }).catch(err => console.error('Sponsor confirmation email error:', err));
    }
  }

  return NextResponse.json({ ok: true });
}
