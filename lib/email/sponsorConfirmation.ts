// Sends the "your sponsorship is confirmed" email. Only call this once
// payment is actually confirmed (webhook AUTHORISATION success) — never at
// initial self-purchase submission.
export async function sendSponsorConfirmationEmail(params: {
  contactEmail: string;
  contactName: string | null;
  company: string;
  tierName: string;
  amountCents: number;
  tournamentName: string;
  eventDate: string;
  locationName?: string | null;
  logoUploadUrl?: string | null;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return; // SendGrid not configured yet — skip silently

  const dateStr = new Date(params.eventDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const fmt = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const greetingName = params.contactName || params.company;

  const detailRow = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 0;font-size:13px;color:#6B7775;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">${label}</td>
      <td style="padding:8px 0;font-size:15px;color:#1A1F1C;font-weight:600;text-align:right;">${value}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FAF8F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F3;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#1B4425;border-radius:14px 14px 0 0;padding:36px 40px;text-align:center;">
            <p style="margin:0 0 6px;color:#D9C58A;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Sponsorship confirmed</p>
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">${params.tournamentName}</h1>
            <p style="margin:10px 0 0;color:rgba(255,255,255,.75);font-size:14px;">${dateStr}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:32px 40px;border-left:1px solid #E5E0D5;border-right:1px solid #E5E0D5;">
            <p style="margin:0 0 20px;font-size:15px;color:#1A1F1C;line-height:1.6;">Hi ${greetingName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#3A3F3C;line-height:1.6;">Thank you for sponsoring ${params.tournamentName} — your payment is confirmed and your business is officially part of the event.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E5E0D5;border-bottom:1px solid #E5E0D5;margin-bottom:24px;">
              ${detailRow('Company', params.company)}
              ${detailRow('Package', params.tierName)}
              ${detailRow('Amount', fmt(params.amountCents))}
              ${params.locationName ? detailRow('Location', params.locationName) : ''}
            </table>
            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1A1F1C;text-transform:uppercase;letter-spacing:.06em;">What happens next</p>
            <p style="margin:0 0 ${params.logoUploadUrl ? 20 : 0}px;font-size:14px;color:#3A3F3C;line-height:1.7;">The organizer will confirm signage and placement details. Reply to this email any time with questions.</p>
            ${params.logoUploadUrl ? `
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
              <a href="${params.logoUploadUrl}" style="display:inline-block;background:#1B6B3A;color:#ffffff;font-weight:700;font-size:14px;padding:12px 28px;border-radius:4px;text-decoration:none;">Upload your logo</a>
            </td></tr></table>
            <p style="margin:12px 0 0;font-size:12px;color:#9BA8A4;text-align:center;">Takes under a minute — it'll show up on the event microsite and signage.</p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="background:#F2EFE7;border-radius:0 0 14px 14px;padding:20px 40px;text-align:center;border:1px solid #E5E0D5;border-top:none;">
            <p style="margin:0;font-size:12px;color:#6B7775;">Powered by <strong style="color:#1B6B3A;">TourneyCoach</strong> — tournaments that fund what matters</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: params.contactEmail, name: greetingName }],
      }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach' },
      subject: `Sponsorship confirmed — ${params.tournamentName}`,
      content: [{ type: 'text/html', value: html }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`SendGrid send failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
}
