// Forwards a prospect's reply to the organizer so the conversation continues
// in their own inbox, even though the reply was routed through Inbound Parse
// for tracking. Best-effort: a send failure must not fail the webhook.
export async function forwardReplyToOrganizer(params: {
  organizerEmail: string;
  organizerName: string;
  fromEmail: string;
  fromName?: string | null;
  company: string;
  subject: string;
  text: string;
  dashboardUrl: string;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bodyHtml = esc(params.text).replace(/\n/g, '<br>');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FAF8F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F3;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background:#1B4425;border-radius:14px 14px 0 0;padding:28px 40px;">
          <p style="margin:0 0 4px;color:#D9C58A;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Sponsor reply</p>
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">${esc(params.company)} replied</h1>
        </td></tr>
        <tr><td style="background:#ffffff;padding:28px 40px;border-left:1px solid #E5E0D5;border-right:1px solid #E5E0D5;">
          <p style="margin:0 0 6px;font-size:13px;color:#6B7775;">From ${esc(params.fromName || params.fromEmail)} &lt;${esc(params.fromEmail)}&gt;</p>
          <p style="margin:0 0 16px;font-size:13px;color:#6B7775;">Re: ${esc(params.subject)}</p>
          <div style="border-left:3px solid #E5E0D5;padding:4px 0 4px 16px;font-size:15px;line-height:1.7;color:#1A1F1C;">${bodyHtml}</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td align="center">
            <a href="${params.dashboardUrl}" style="display:inline-block;background:#1B6B3A;color:#ffffff;font-weight:700;font-size:14px;padding:12px 28px;border-radius:4px;text-decoration:none;">Open your sponsor pipeline</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="background:#F2EFE7;border-radius:0 0 14px 14px;padding:18px 40px;text-align:center;border:1px solid #E5E0D5;border-top:none;">
          <p style="margin:0;font-size:12px;color:#6B7775;">Reply directly to reach ${esc(params.fromName || params.company)} — Powered by <strong style="color:#1B6B3A;">TourneyCoach</strong></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: params.organizerEmail, name: params.organizerName }] }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach' },
      // So the organizer can just hit reply and reach the actual prospect.
      reply_to: { email: params.fromEmail, name: params.fromName || undefined },
      subject: `${params.company} replied — ${params.subject}`,
      content: [{ type: 'text/html', value: html }],
    }),
  });
}
