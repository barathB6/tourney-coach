import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendComm } from '@/lib/comm/engine';
import { toE164 } from '@/lib/sms/twilio';
import { getPublicAppUrl } from '@/lib/publicUrl';

const getService = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Volunteer sign-in. Volunteers have no account and never will — asking a
// retired member of the church committee to create a password to hand out gift
// bags is how you lose volunteers. They identify with the email or phone the
// organizer already has, and we send their access link back to that same
// address. The link (the per-assignment token) remains the credential.
//
// SECURITY: the response is identical whether or not we found anybody. This
// endpoint is unauthenticated, so a distinguishable response would turn it into
// a "does this person volunteer anywhere?" oracle — the same reasoning that
// governs the TourneyCircle disclosure rules.
const SAME_ANSWER = {
  ok: true,
  message: 'If that email or phone is on a volunteer list, we have just sent your link. Check your messages.',
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const raw = typeof body?.contact === 'string' ? body.contact.trim().slice(0, 160) : '';
  if (!raw) return NextResponse.json({ error: 'Enter the email or phone number the organizer has for you.' }, { status: 400 });

  const service = getService();
  const isEmail = raw.includes('@');
  const email = isEmail ? raw.toLowerCase() : null;
  const phone = isEmail ? null : toE164(raw);

  if (!email && !phone) {
    return NextResponse.json({ error: 'That does not look like an email address or a phone number.' }, { status: 400 });
  }

  // Every volunteer row matching this contact, across every tournament.
  const query = service.from('volunteers').select('id, tournament_id, name, email, phone');
  const { data: vols } = email
    ? await query.ilike('email', email)
    : await query.eq('phone', raw).limit(20);

  // Phone numbers are stored however the organizer typed them, so an exact
  // match is not enough — normalise both sides before comparing.
  const matched = (vols ?? []).filter((v) => {
    if (email) return true;
    return toE164(v.phone as string | null) === phone;
  });

  for (const v of matched) {
    const { data: assigns } = await service.from('tournament_volunteer_assignments')
      .select('invite_token, role_templates(name)')
      .eq('tournament_id', v.tournament_id as string)
      .eq('volunteer_id', v.id as string)
      .neq('status', 'declined')
      .limit(1);
    const token = (assigns ?? [])[0]?.invite_token as string | undefined;
    if (!token) continue;

    const { data: t } = await service.from('tournaments')
      .select('name').eq('id', v.tournament_id as string).maybeSingle();

    await sendComm(service, {
      recipient: {
        volunteerId: v.id as string,
        tournamentId: v.tournament_id as string,
        name: (v.name as string | null) ?? null,
        email: (v.email as string | null) ?? null,
        phone: (v.phone as string | null) ?? null,
      },
      kind: 'invite',
      subject: `Your volunteer link — ${(t?.name as string) ?? 'your tournament'}`,
      body: `Here is your volunteer page. It keeps your checklist, your messages, and everything you need on the day:\n\n${getPublicAppUrl()}/v/${token}\n\nNo password needed — this link is yours. Save it to your home screen.`,
      // Reply on the channel they used to ask.
      channel: email ? 'email' : 'sms',
    });
  }

  return NextResponse.json(SAME_ANSWER);
}
