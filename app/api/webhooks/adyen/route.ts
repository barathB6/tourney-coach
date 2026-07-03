import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPaymentProcessor } from '@/lib/payments';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Adyen requires a plain [accepted] text response to acknowledge receipt
const ACK = NextResponse.json('[accepted]', { status: 200 });

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const hmacSignature = req.headers.get('x-adyen-hmac-signature') ?? '';

    const processor = await getPaymentProcessor();
    const event = processor.parseWebhook(body, hmacSignature);

    if (!event) {
      // Invalid HMAC or unrecognised format — still return 200 so Adyen stops retrying
      console.warn('Adyen webhook: invalid HMAC or format');
      return ACK;
    }

    const supabase = getSupabase();
    const { eventCode, success, merchantReference, pspReference } = event;

    if (eventCode === 'AUTHORISATION') {
      if (success) {
        await supabase
          .from('registrations')
          .update({ payment_status: 'paid', adyen_psp_reference: pspReference })
          .eq('id', merchantReference)
          .eq('payment_status', 'pending'); // idempotency guard
      } else {
        await supabase
          .from('registrations')
          .update({ payment_status: 'failed' })
          .eq('id', merchantReference)
          .eq('payment_status', 'pending');
      }
    }

    if (eventCode === 'REFUND') {
      if (success) {
        await supabase
          .from('registrations')
          .update({ payment_status: 'refunded' })
          .eq('adyen_psp_reference', pspReference);
      }
    }

    if (eventCode === 'CHARGEBACK') {
      await supabase
        .from('registrations')
        .update({ payment_status: 'failed' })
        .eq('adyen_psp_reference', pspReference);
    }

    return ACK;
  } catch (err) {
    console.error('Adyen webhook error:', err);
    // Still return 200 — Adyen retries on non-200, which could cause duplicate processing
    return ACK;
  }
}
