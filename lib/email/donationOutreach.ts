// Sends an in-kind donation request (or its follow-up) to a vendor prospect.
//
// Mirrors lib/email/sponsorOutreach.ts on purpose: same SendGrid open/click
// tracking, same per-recipient reply address so the inbound webhook can
// attribute a reply and stop the cadence. The custom_arg is `prospect_id`
// rather than `sponsor_id`, which is how the shared event webhook tells a
// donation open from a sponsorship open.
export async function sendDonationOutreachEmail(params: {
  to: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  organizerName: string;
  organizerEmail?: string | null;
  prospectId: string;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error('SendGrid is not configured — add SENDGRID_API_KEY to enable sending donation requests.');
  }

  const html = params.bodyText
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1A1F1C;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  // Same reply-domain fallback as sponsor outreach: with Inbound Parse
  // configured, replies are attributable and stop the follow-up cadence;
  // without it they still reach the organizer, just untracked.
  const replyDomain = process.env.SPONSOR_REPLY_DOMAIN;
  const replyTo = replyDomain
    ? { email: `reply-${params.prospectId}@${replyDomain}`, name: params.organizerName }
    : (params.organizerEmail ? { email: params.organizerEmail, name: params.organizerName } : undefined);

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: params.to, name: params.toName || undefined }],
        custom_args: { prospect_id: params.prospectId },
      }],
      from: { email: 'noreply@tourneycoach.com', name: `${params.organizerName} via TourneyCoach` },
      reply_to: replyTo,
      subject: params.subject,
      content: [
        { type: 'text/plain', value: params.bodyText },
        { type: 'text/html', value: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;">${html}</div>` },
      ],
      tracking_settings: {
        click_tracking: { enable: true, enable_text: true },
        open_tracking: { enable: true },
      },
      categories: ['donation-outreach'],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`SendGrid send failed (${res.status}): ${errBody.slice(0, 300)}`);
  }

  return { messageId: res.headers.get('x-message-id') };
}
