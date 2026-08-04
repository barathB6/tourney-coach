import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendComm } from '@/lib/comm/engine';
import { toE164 } from '@/lib/sms/twilio';
import { getPublicAppUrl } from '@/lib/publicUrl';
import { issueCode, verifyCode } from '@/lib/volunteer/accessCode';

const getService = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Volunteer sign-in, in two steps, without ever leaving the site.
//
//   step 1 (no code)  → send a 6-digit code to the contact they claim
//   step 2 (+ code)   → verify, then hand back their roles and tokens
//
// Volunteers have no account and never will. Asking a retired member of the
// church committee to create a password before she can hand out gift bags is
// how a tournament loses volunteers.
//
// SECURITY: the token behind each role is a credential — it exposes that
// volunteer's details and lets the holder decline their role or write to the
// organizer as them. So we cannot simply show it to whoever types an email.
// Possession of the email or phone still proves identity; the code just means
// the volunteer proves it here instead of hunting through their inbox.
//
// Step 1's response is identical whether or not anybody matched. This endpoint
// is unauthenticated, so a distinguishable answer would make it a "does this
// person volunteer anywhere?" oracle — the same reasoning behind the
// TourneyCircle disclosure rules.
const SENT = {
  ok: true,
  sent: true,
  message: 'If that email or phone is on a volunteer list, we just sent a 6-digit code. It expires in 10 minutes.',
};

function normalise(raw: string): { contact: string; isEmail: boolean } | null {
  const trimmed = raw.trim().slice(0, 160);
  if (!trimmed) return null;
  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { contact: email, isEmail: true } : null;
  }
  const phone = toE164(trimmed);
  return phone ? { contact: phone, isEmail: false } : null;
}

/** Every volunteer row matching this contact, with its usable token. */
async function rolesFor(service: ReturnType<typeof getService>, contact: string, isEmail: boolean) {
  const q = service.from('volunteers').select('id, tournament_id, name, email, phone');
  const { data: vols } = isEmail ? await q.ilike('email', contact) : await q.limit(500);

  // Phone numbers are stored however the organizer typed them, so an exact
  // column match is not enough — normalise both sides before comparing.
  const matched = (vols ?? []).filter((v) =>
    isEmail ? true : toE164(v.phone as string | null) === contact);

  const out: { token: string; tournamentName: string; roleName: string; volunteerName: string; eventDate: string | null; status: string }[] = [];
  for (const v of matched) {
    const { data: assigns } = await service.from('tournament_volunteer_assignments')
      .select('invite_token, status, role_templates(name)')
      .eq('tournament_id', v.tournament_id as string)
      .eq('volunteer_id', v.id as string)
      .neq('status', 'declined');
    if (!assigns?.length) continue;

    const { data: t } = await service.from('tournaments')
      .select('name, event_date').eq('id', v.tournament_id as string).maybeSingle();

    for (const a of assigns) {
      out.push({
        token: a.invite_token as string,
        tournamentName: (t?.name as string) ?? 'Your tournament',
        roleName: ((a.role_templates as unknown as { name?: string } | null)?.name) ?? 'Volunteer',
        volunteerName: (v.name as string | null) ?? 'there',
        eventDate: (t?.event_date as string | null) ?? null,
        status: a.status as string,
      });
    }
  }
  // Soonest event first — the one they are most likely here for.
  return out.sort((a, b) => (a.eventDate ?? '9999').localeCompare(b.eventDate ?? '9999'));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const raw = typeof body?.contact === 'string' ? body.contact : '';
  const code = typeof body?.code === 'string' ? body.code.replace(/\D/g, '').slice(0, 6) : '';

  const parsed = normalise(raw);
  if (!parsed) {
    return NextResponse.json({ error: 'That does not look like an email address or a phone number.' }, { status: 400 });
  }
  const { contact, isEmail } = parsed;
  const service = getService();

  // ── Step 2: verify the code and hand back their view ─────────────────────
  if (code) {
    if (code.length !== 6) return NextResponse.json({ error: 'Enter the 6-digit code.' }, { status: 400 });
    const result = await verifyCode(service, contact, code);
    if (!result.ok) {
      const message = result.reason === 'expired' ? 'That code has expired. Ask for a new one.'
        : result.reason === 'exhausted' ? 'Too many tries. Ask for a new code.'
        : result.reason === 'none' ? 'Ask for a code first.'
        : 'That code is not right.';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const roles = await rolesFor(service, contact, isEmail);
    if (!roles.length) {
      // The code was valid, so this person does control the contact — telling
      // them there is nothing here leaks nothing they did not already prove.
      return NextResponse.json({ ok: true, verified: true, roles: [],
        message: 'That code checked out, but nobody has added you to a volunteer list yet. Ask your organizer to send you an invitation.' });
    }
    return NextResponse.json({ ok: true, verified: true, roles });
  }

  // ── Step 1: issue and send ───────────────────────────────────────────────
  const roles = await rolesFor(service, contact, isEmail);

  // No match: return the same answer, and send nothing. Timing differs
  // slightly, but the response body — which is what an attacker can actually
  // read cheaply at scale — does not.
  if (!roles.length) return NextResponse.json(SENT);

  const issued = await issueCode(service, contact);
  if (issued.rateLimited) {
    return NextResponse.json({ error: 'Too many codes requested. Try again in an hour, or use the link we already sent you.' }, { status: 429 });
  }
  if (!issued.ok || !issued.code) {
    return NextResponse.json({ error: 'Could not send a code just now — run migration 045 if this persists.' }, { status: 500 });
  }

  // Send to the first matching volunteer record; the contact is the same
  // person across all of them.
  const { data: vols } = isEmail
    ? await service.from('volunteers').select('id, tournament_id, name, email, phone').ilike('email', contact).limit(1)
    : await service.from('volunteers').select('id, tournament_id, name, email, phone').limit(500);
  const v = isEmail ? (vols ?? [])[0]
    : (vols ?? []).find((x) => toE164(x.phone as string | null) === contact);
  if (!v) return NextResponse.json(SENT);

  await sendComm(service, {
    recipient: {
      volunteerId: v.id as string,
      tournamentId: v.tournament_id as string,
      name: (v.name as string | null) ?? null,
      email: (v.email as string | null) ?? null,
      phone: (v.phone as string | null) ?? null,
    },
    kind: 'invite',
    subject: `${issued.code} is your TourneyCoach code`,
    body: `Your code is ${issued.code}. Type it on the sign-in page to open your volunteer view. It expires in 10 minutes.\n\nIf you would rather use a direct link: ${getPublicAppUrl()}/v/${roles[0].token}`,
    channel: isEmail ? 'email' : 'sms',
  });

  return NextResponse.json(SENT);
}
