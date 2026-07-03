import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPaymentProcessor } from '@/lib/payments';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { registration_id, return_url } = await req.json();

    if (!registration_id) {
      return NextResponse.json({ error: 'registration_id required' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: reg, error } = await supabase
      .from('registrations')
      .select('id, total_amount_cents, contact_email, contact_name, payment_status, tournament_id')
      .eq('id', registration_id)
      .single();

    if (error || !reg) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
    }

    if (reg.payment_status === 'paid') {
      return NextResponse.json({ error: 'Already paid' }, { status: 409 });
    }

    const processor = await getPaymentProcessor();
    const session = await processor.createSession({
      registrationId: reg.id,
      amountCents: reg.total_amount_cents,
      currency: 'USD',
      description: `Tournament registration — ${reg.id}`,
      returnUrl: return_url ?? `${process.env.NEXT_PUBLIC_APP_URL}/register/complete?id=${reg.id}`,
      shopperEmail: reg.contact_email,
      shopperName: reg.contact_name,
    });

    return NextResponse.json(session, { status: 201 });
  } catch (err) {
    console.error('Payment intent error:', err);
    return NextResponse.json({ error: 'Failed to create payment session' }, { status: 500 });
  }
}
