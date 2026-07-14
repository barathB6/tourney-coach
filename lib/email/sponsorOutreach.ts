// Sends an outreach or follow-up email to a sponsorship prospect on the
// organizer's behalf, with SendGrid open/click tracking enabled and the
// sponsor id tagged via custom_args so the event webhook can attribute
// engagement back to the right prospect.
export async function sendSponsorOutreachEmail(params: {
  to: string;
  toName?: string | null;
  subject: string;
  bodyText: string;
  organizerName: string;
  organizerEmail?: string | null;
  sponsorId: string;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error('SendGrid is not configured — add SENDGRID_API_KEY to enable sending outreach emails.');
  }

  const html = params.bodyText
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1A1F1C;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: params.to, name: params.toName || undefined }],
        custom_args: { sponsor_id: params.sponsorId },
      }],
      from: {
        email: 'noreply@tourneycoach.com',
        name: `${params.organizerName} via TourneyCoach`,
      },
      reply_to: params.organizerEmail ? { email: params.organizerEmail, name: params.organizerName } : undefined,
      subject: params.subject,
      content: [
        { type: 'text/plain', value: params.bodyText },
        { type: 'text/html', value: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;">${html}</div>` },
      ],
      tracking_settings: {
        click_tracking: { enable: true, enable_text: true },
        open_tracking: { enable: true },
      },
      categories: ['sponsor-outreach'],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`SendGrid send failed (${res.status}): ${errBody.slice(0, 300)}`);
  }

  // SendGrid returns the message id in the X-Message-Id response header
  return { messageId: res.headers.get('x-message-id') };
}
