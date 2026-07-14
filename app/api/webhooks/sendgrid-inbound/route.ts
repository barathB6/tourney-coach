import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { forwardReplyToOrganizer } from '@/lib/email/forwardReply';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Always ack so SendGrid Inbound Parse doesn't retry — we own our own errors.
const ACK = NextResponse.json({ ok: true }, { status: 200 });

// Statuses that already represent a resolved outcome — a late reply shouldn't
// downgrade a committed or declined sponsor, but we still record it.
const TERMINAL = new Set(['paid', 'invoiced', 'declined']);

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
      .single();
    if (!sponsor) return ACK;

    const snippet = topOfReply(text).slice(0, 800);
    const now = new Date().toISOString();
    const nextStatus = TERMINAL.has(sponsor.status) ? sponsor.status : 'replied';

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
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.tourneycoach.com';
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
