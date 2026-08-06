import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { forwardReplyToOrganizer } from '@/lib/email/forwardReply';
import { getPublicAppUrl } from '@/lib/publicUrl';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Always ack so SendGrid Inbound Parse doesn't retry — we own our own errors.
const ACK = NextResponse.json({ ok: true }, { status: 200 });

// An inbound email may only advance the two states that MEAN "we are waiting
// to hear back". Every other status was established by the organizer or by a
// payment, and an email must not undo it. The reply itself (replied_at,
// reply_snippet, last_touch) is recorded either way, and forwarded either way.
//
// This was an allow-list of terminal states — paid/invoiced/declined — which
// left two live states exposed, both reachable by anyone who has the sponsor
// uuid from the Reply-To of an outreach email:
//
//   'verbal'  counts as SOLD inventory (api/sponsors/purchase counts
//             paid+invoiced+verbal against tier quantity). Knocking it back to
//             'replied' reopened a quantity-1 tier for a second sale, and took
//             away the "Send invoice" action, which only renders on 'verbal'.
//             An out-of-office auto-reply was enough to do it.
//
//   'pending' is mid-checkout. The Adyen webhook flips to paid with
//             .eq('status','pending'); moving the row out from under it meant
//             the card was charged and the sponsor never marked paid — no
//             confirmation, absent from sold counts and the recognition list.
const AWAITING_REPLY = new Set(['contacted', 'no_reply']);

function extractSponsorId(...candidates: (string | null | undefined)[]): string | null {
  const re = /reply-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
  for (const c of candidates) {
    const m = c?.match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function parseFrom(raw: string): { email: string; name: string | null } {
  const angle = raw.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : raw).trim();
  const name = angle ? raw.slice(0, raw.indexOf('<')).trim().replace(/^"|"$/g, '') : null;
  return { email, name: name || null };
}

// Trim quoted history so the stored snippet is the prospect's actual words.
function topOfReply(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim() || text.trim();
}

export async function POST(req: NextRequest) {
  // Optional shared-secret guard: if set, the Parse URL must include ?token=…
  const expected = process.env.SENDGRID_INBOUND_TOKEN;
  if (expected && req.nextUrl.searchParams.get('token') !== expected) {
    return ACK; // silently ignore unauthenticated posts
  }

  try {
    const form = await req.formData();
    const envelope = form.get('envelope')?.toString();
    const toField = form.get('to')?.toString();
    const fromField = form.get('from')?.toString() ?? '';
    const subject = form.get('subject')?.toString() ?? '(no subject)';
    const text = form.get('text')?.toString() ?? '';

    let envelopeTo: string | undefined;
    try {
      if (envelope) {
        const parsed = JSON.parse(envelope);
        envelopeTo = Array.isArray(parsed.to) ? parsed.to.join(',') : parsed.to;
      }
    } catch { /* envelope not JSON — fall back to the To header */ }

    const sponsorId = extractSponsorId(envelopeTo, toField);
    if (!sponsorId) return ACK; // not one of our tracked reply addresses

    const supabase = getSupabase();
    const { data: sponsor } = await supabase
      .from('sponsors')
      .select('id, company, status, tournament_id')
      .eq('id', sponsorId)
      .maybeSingle();

    const snippet = topOfReply(text).slice(0, 800);
    const now = new Date().toISOString();

    // Vendor donation outreach uses the same reply-<uuid>@ address shape, so an
    // id that isn't a sponsor may be a donation prospect. This is what stops
    // the 7-day follow-up cadence: the cron only chases 'sent' and 'opened'.
    if (!sponsor) {
      const { data: prospect } = await supabase
        .from('donation_prospects')
        .select('id, company, name, status, tournament_id')
        .eq('id', sponsorId)
        .maybeSingle();
      if (!prospect) return ACK;

      // A reply never overrides an outcome the organizer already recorded.
      const resolved = prospect.status === 'committed' || prospect.status === 'declined';
      await supabase.from('donation_prospects').update({
        status: resolved ? prospect.status : 'responded',
        responded_at: now,
        reply_snippet: snippet || null,
        last_contact_at: now,
        updated_at: now,
      }).eq('id', prospect.id);

      await supabase.from('donation_outreach_log').insert({
        prospect_id: prospect.id,
        tournament_id: prospect.tournament_id,
        method: 'email',
        direction: 'inbound',
        outcome: 'replied',
        subject,
        body: snippet || null,
        contacted_at: now,
      });

      const { data: tournamentRow } = await supabase
        .from('tournaments').select('organizer_id').eq('id', prospect.tournament_id).maybeSingle();
      if (tournamentRow) {
        const { data: organizerUser } = await supabase.auth.admin.getUserById(tournamentRow.organizer_id);
        const organizerEmail = organizerUser?.user?.email;
        if (organizerEmail) {
          const from = parseFrom(fromField);
          await forwardReplyToOrganizer({
            organizerEmail,
            organizerName: organizerUser?.user?.user_metadata?.full_name || organizerUser?.user?.user_metadata?.name || 'Organizer',
            fromEmail: from.email,
            fromName: from.name,
            company: (prospect.company as string | null) ?? (prospect.name as string | null) ?? 'A vendor',
            subject,
            text: snippet,
            dashboardUrl: `${getPublicAppUrl()}/fb`,
          }).catch(err => console.error('Donation reply forward failed:', err));
        }
      }
      return ACK;
    }
    const nextStatus = AWAITING_REPLY.has(sponsor.status) ? 'replied' : sponsor.status;

    await supabase
      .from('sponsors')
      .update({ status: nextStatus, replied_at: now, reply_snippet: snippet || null, last_touch: now })
      .eq('id', sponsor.id);

    // Forward to the organizer so the conversation lives in their inbox.
    const { data: tournament } = await supabase
      .from('tournaments')
      .select('organizer_id')
      .eq('id', sponsor.tournament_id)
      .single();
    if (tournament) {
      const { data: organizerUser } = await supabase.auth.admin.getUserById(tournament.organizer_id);
      const organizerEmail = organizerUser?.user?.email;
      if (organizerEmail) {
        const from = parseFrom(fromField);
        const appUrl = getPublicAppUrl();
        await forwardReplyToOrganizer({
          organizerEmail,
          organizerName: organizerUser?.user?.user_metadata?.full_name || organizerUser?.user?.user_metadata?.name || 'Organizer',
          fromEmail: from.email,
          fromName: from.name,
          company: sponsor.company,
          subject,
          text: snippet,
          dashboardUrl: `${appUrl}/sponsors`,
        }).catch(err => console.error('Reply forward failed:', err));
      }
    }

    return ACK;
  } catch (err) {
    console.error('Inbound parse webhook error:', err);
    return ACK;
  }
}
