// Communication Engine — one door for everything TourneyCoach sends a
// volunteer: SMS (Twilio), email (SendGrid), Web Push, and in-app messages.
//
// Rules the whole file enforces:
//
//   - EVERY send is a ledger row in communication_log, written BEFORE the
//     provider is called (claim-before-send for cadence sends, so two cron
//     runs cannot double-text anyone) and updated with what actually happened.
//     A failed send is recorded as failed with the real error — never deleted,
//     never silently retried into a duplicate.
//   - The in-app channel cannot fail. It IS a ledger row with status
//     'delivered'; the volunteer portal reads it. Every SMS/email/push send is
//     also mirrored in-app, so the portal always shows the full history even
//     when a phone number was wrong.
//   - Channel selection is the guidance profile's job (lib/guidance/engine);
//     this file only degrades to what is actually reachable.

import type { SupabaseClient } from '@supabase/supabase-js';
import { captureError } from '@/lib/observability/report';
import { sendSms, twilioConfigured } from '@/lib/sms/twilio';
import { usableChannel, type Channel } from '@/lib/guidance/engine';
import { sendWebPush, pushConfigured } from '@/lib/comm/push';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

export type CommKind = 'reminder' | 'guidance' | 'broadcast' | 'reply' | 'escalation' | 'invite' | 'ad_hoc';

export interface Recipient {
  volunteerId: string;
  tournamentId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface SendRequest {
  recipient: Recipient;
  kind: CommKind;
  subject: string;
  body: string;
  /** Preferred channel from the guidance profile; engine degrades if unusable. */
  channel: Channel;
  /** Cadence claim key — required for kind 'reminder', forbidden otherwise. */
  offsetKey?: string;
  meta?: Record<string, unknown>;
}

export interface SendOutcome {
  ok: boolean;
  channel: Channel;
  attempted: Channel;
  ledgerId: string | null;
  error?: string;
  /** True when the claim already existed — someone else sent this slot. */
  alreadyClaimed?: boolean;
}

async function sendEmailRaw(
  to: string, subject: string, bodyText: string, fromName: string,
  tags: { volunteerId?: string; ledgerId?: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { ok: false, error: 'SendGrid is not configured (SENDGRID_API_KEY)' };
  const html = bodyText.split(/\n\n+/)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1A1F1C;">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
    .join('');
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // custom_args round-trip through the SendGrid event webhook, which is
      // what turns "was this email opened?" into a real engagement signal
      // instead of an assumption. Without this the guidance engine would count
      // every sent email as unopened.
      personalizations: [{
        to: [{ email: to }],
        custom_args: {
          ...(tags.volunteerId ? { volunteer_id: tags.volunteerId } : {}),
          ...(tags.ledgerId ? { comm_log_id: tags.ledgerId } : {}),
        },
      }],
      from: { email: 'noreply@tourneycoach.com', name: fromName },
      subject,
      content: [
        { type: 'text/plain', value: bodyText },
        { type: 'text/html', value: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;">${html}</div>` },
      ],
      tracking_settings: {
        open_tracking: { enable: true },
        click_tracking: { enable: true, enable_text: true },
      },
      categories: ['comm-engine'],
    }),
  });
  if (!res.ok) return { ok: false, error: `SendGrid ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
  return { ok: true, id: res.headers.get('x-message-id') ?? undefined };
}

/**
 * Send through the engine. Resolution order:
 *  1. Degrade the preferred channel to one that is reachable for this person.
 *  2. Claim the ledger row (unique index enforces cadence idempotency).
 *  3. Call the provider; record success or the real failure.
 *  4. Mirror to in-app unless the delivery channel already was in-app.
 */
export async function sendComm(service: DB, req: SendRequest, fromName = 'TourneyCoach'): Promise<SendOutcome> {
  const r = req.recipient;
  const { data: sub } = r.volunteerId
    ? await service.from('push_subscriptions').select('endpoint, p256dh, auth').eq('volunteer_id', r.volunteerId).limit(3)
    : { data: [] };
  const subs = sub ?? [];

  const attempted = req.channel;
  const channel = usableChannel(req.channel, {
    phone: !!r.phone && twilioConfigured(),
    email: !!r.email,
    push: subs.length > 0 && pushConfigured(),
  });

  // ── Claim the ledger row first ────────────────────────────────────────────
  const { data: claim, error: claimErr } = await service.from('communication_log').insert({
    tournament_id: r.tournamentId,
    volunteer_id: r.volunteerId,
    recipient_email: r.email,
    recipient_phone: r.phone,
    channel,
    kind: req.kind,
    subject: req.subject,
    body: req.body,
    status: channel === 'in_app' ? 'delivered' : 'queued',
    offset_key: req.kind === 'reminder' ? (req.offsetKey ?? null) : null,
    meta: req.meta ?? null,
    sent_at: new Date().toISOString(),
  }).select('id').single();

  if (claimErr || !claim) {
    if (claimErr?.code === '23505') {
      return { ok: false, channel, attempted, ledgerId: null, alreadyClaimed: true, error: 'This reminder slot was already sent.' };
    }
    return { ok: false, channel, attempted, ledgerId: null, error: claimErr?.message ?? 'Could not write the send ledger — run migration 043.' };
  }
  const ledgerId = claim.id as string;

  // ── Deliver ───────────────────────────────────────────────────────────────
  let ok = true;
  let error: string | undefined;
  let messageId: string | null = null;

  if (channel === 'sms') {
    const res = await sendSms({ to: r.phone!, body: `${req.subject}\n${req.body}` });
    ok = res.ok; error = res.error; messageId = res.sid ?? null;
  } else if (channel === 'email') {
    const res = await sendEmailRaw(r.email!, req.subject, req.body, fromName,
      { volunteerId: r.volunteerId, ledgerId });
    ok = res.ok; error = res.error; messageId = res.id ?? null;
  } else if (channel === 'push') {
    const res = await sendWebPush(subs, { title: req.subject, body: req.body });
    ok = res.ok; error = res.error; messageId = res.delivered > 0 ? `push:${res.delivered}` : null;
  } // in_app: the ledger row IS the delivery.

  await service.from('communication_log').update({
    status: ok ? (channel === 'in_app' ? 'delivered' : 'sent') : 'failed',
    message_id: messageId,
    error: error ? error.slice(0, 500) : null,
  }).eq('id', ledgerId);

  // A failed send is the quietest failure in the product: the ledger row says
  // 'failed', the in-app mirror still shows the volunteer the message, and
  // nobody finds out until the person doesn't turn up.
  if (!ok) {
    captureError(error ?? `${channel} send failed`, {
      scope: 'comm.send',
      tournamentId: r.tournamentId,
      detail: { channel, kind: req.kind, offsetKey: req.offsetKey ?? null, ledgerId, attempted },
    });
  }

  // ── In-app mirror ─────────────────────────────────────────────────────────
  // The portal shows everything we tried to tell them, whichever pipe carried
  // it — and it is the only channel with no failure mode.
  if (channel !== 'in_app') {
    await service.from('communication_log').insert({
      tournament_id: r.tournamentId,
      volunteer_id: r.volunteerId,
      channel: 'in_app',
      kind: req.kind,
      subject: req.subject,
      body: req.body,
      status: 'delivered',
      meta: { mirror_of: ledgerId, delivered_via: ok ? channel : 'nothing', ...(req.meta ?? {}) },
      sent_at: new Date().toISOString(),
    });
  }

  return { ok, channel, attempted, ledgerId, error };
}
