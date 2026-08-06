import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { captureError } from '@/lib/observability/report';
import { getPaymentProcessor } from '@/lib/payments';
import { sendConfirmationEmail } from '@/lib/email/confirmation';
import { sendSponsorConfirmationEmail } from '@/lib/email/sponsorConfirmation';
import { getPublicAppUrl } from '@/lib/publicUrl';

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
    const { eventCode, success, merchantReference, pspReference, originalReference } = event;

    // Sponsorship payments use a "sponsor:<id>" merchant reference
    if (merchantReference?.startsWith('sponsor:')) {
      const sponsorId = merchantReference.slice('sponsor:'.length);
      if (eventCode === 'AUTHORISATION') {
        if (success) {
          const { data: paidSponsor } = await supabase
            .from('sponsors')
            .update({ status: 'paid', adyen_psp_reference: pspReference, last_touch: new Date().toISOString() })
            .eq('id', sponsorId)
            .eq('status', 'pending')
            .select('id, company, contact_name, email, amount_cents, logo_url, tournament_id, sponsorship_tiers(name), tournaments(name, slug, event_date, location_name)')
            .single();

          // The .eq('status','pending') guard is right — it stops a replayed
          // notification double-processing — but matching ZERO rows means the
          // card was charged and the sponsor was NOT marked paid. That is the
          // most expensive silent failure in the product, and until now the
          // webhook ACKed it and moved on. (Day 31 fixed one cause: an inbound
          // email moving the row out of 'pending'. This reports whatever the
          // next cause turns out to be.)
          if (!paidSponsor) {
            captureError('AUTHORISATION matched no pending sponsor — card charged, sponsor not marked paid', {
              scope: 'payments.adyen',
              detail: { sponsorId, pspReference, merchantReference },
            });
          }

          if (paidSponsor?.email) {
            const tier = paidSponsor.sponsorship_tiers as unknown as { name: string } | null;
            const tournament = paidSponsor.tournaments as unknown as { name: string; slug: string; event_date: string; location_name: string | null } | null;
            if (tournament) {
              const appUrl = getPublicAppUrl();
              sendSponsorConfirmationEmail({
                contactEmail: paidSponsor.email,
                contactName: paidSponsor.contact_name,
                company: paidSponsor.company,
                tierName: tier?.name ?? 'Sponsorship',
                amountCents: paidSponsor.amount_cents ?? 0,
                tournamentName: tournament.name,
                eventDate: tournament.event_date,
                locationName: tournament.location_name,
                logoUploadUrl: paidSponsor.logo_url ? null : `${appUrl}/microsite/${tournament.slug}/sponsor/${paidSponsor.id}/logo`,
              }).catch(err => console.error('Sponsor confirmation email error:', err));
            }
          }
        } else {
          // A declined/failed card must not read as "invoiced" (which implies
          // we're expecting a check) — that hid failed payments as confirmed
          // commitments and permanently occupied a tier slot for a purchase
          // that never happened.
          await supabase
            .from('sponsors')
            .update({ status: 'declined' })
            .eq('id', sponsorId)
            .eq('status', 'pending');
        }
      }
      return ACK;
    }

    if (eventCode === 'AUTHORISATION') {
      if (success) {
        // .eq('payment_status', 'pending') both guards against double-processing
        // a replayed webhook and tells us whether *this* call was the one that
        // flipped it — only that caller should send the confirmation email.
        const { data: updated } = await supabase
          .from('registrations')
          .update({ payment_status: 'paid', adyen_psp_reference: pspReference })
          .eq('id', merchantReference)
          .eq('payment_status', 'pending')
          .select('id, contact_name, contact_email, team_name, foursome_number, starting_hole, total_amount_cents, platform_fee_cents, tournaments(name, event_date, location_name)')
          .single();

        // Same reasoning as the sponsor branch: zero rows matched means a
        // player's card was charged and their registration is still 'pending'
        // — no confirmation email, and they are not on the roster.
        if (!updated) {
          captureError('AUTHORISATION matched no pending registration — card charged, entry not confirmed', {
            scope: 'payments.adyen',
            detail: { registrationId: merchantReference, pspReference },
          });
        }

        if (updated) {
          const tournament = updated.tournaments as unknown as { name: string; event_date: string; location_name: string | null } | null;
          if (tournament) {
            sendConfirmationEmail({
              contactEmail: updated.contact_email,
              contactName: updated.contact_name,
              teamName: updated.team_name,
              tournamentName: tournament.name,
              eventDate: tournament.event_date,
              foursomeNumber: updated.foursome_number,
              startingHole: updated.starting_hole,
              registrationId: updated.id,
              locationName: tournament.location_name,
              subtotalCents: updated.total_amount_cents - updated.platform_fee_cents,
              platformFeeCents: updated.platform_fee_cents,
            }).catch(err => console.error('Confirmation email error:', err));

            await supabase
              .from('registrations')
              .update({ confirmation_sent_at: new Date().toISOString() })
              .eq('id', updated.id);
          }
        }
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
        // REFUND events carry the original payment reference in originalReference;
        // pspReference is the refund's own reference
        await supabase
          .from('registrations')
          .update({ payment_status: 'refunded' })
          .eq('adyen_psp_reference', originalReference ?? pspReference);
      }
    }

    if (eventCode === 'CHARGEBACK') {
      await supabase
        .from('registrations')
        .update({ payment_status: 'failed' })
        .eq('adyen_psp_reference', originalReference ?? pspReference);
    }

    return ACK;
  } catch (err) {
    console.error('Adyen webhook error:', err);
    // Still return 200 — Adyen retries on non-200, which could cause duplicate processing
    return ACK;
  }
}
