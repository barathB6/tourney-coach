import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPaymentProcessor } from '@/lib/payments';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const supabase = getSupabase();

    // Verify the token belongs to an authenticated organizer
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { registration_id, reason } = await req.json();
    if (!registration_id) {
      return NextResponse.json({ error: 'registration_id required' }, { status: 400 });
    }

    // Fetch registration and verify organizer owns the tournament
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select('id, total_amount_cents, payment_status, adyen_psp_reference, tournament_id')
      .eq('id', registration_id)
      .single();

    if (regErr || !reg) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
    }

    // Verify organizer owns the tournament
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('organizer_id')
      .eq('id', reg.tournament_id)
      .single();

    if (tournament?.organizer_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (reg.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Registration is not in paid status' }, { status: 409 });
    }

    if (!reg.adyen_psp_reference) {
      return NextResponse.json({ error: 'No PSP reference — cannot refund' }, { status: 409 });
    }

    const processor = await getPaymentProcessor();
    const result = await processor.refund({
      pspReference: reg.adyen_psp_reference,
      amountCents: reg.total_amount_cents,
      currency: 'USD',
      reason: reason ?? 'Organizer-initiated refund',
    });

    return NextResponse.json({ pspReference: result.pspReference, status: result.status });
  } catch (err) {
    console.error('Refund error:', err);
    return NextResponse.json({ error: 'Refund request failed' }, { status: 500 });
  }
}
