// Sends the "you're registered" email. Only call this once payment is
// actually confirmed (webhook AUTHORISATION success, or a manual paper
// registration marked paid at creation) — never at initial signup.
export async function sendConfirmationEmail(params: {
  contactEmail: string;
  contactName: string;
  teamName: string | null;
  tournamentName: string;
  eventDate: string;
  foursomeNumber: number;
  startingHole: number | null;
  registrationId: string;
  locationName?: string | null;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return; // SendGrid not configured yet — skip silently

  const dateStr = new Date(params.eventDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.tourneycoach.com';
  const qrParams = new URLSearchParams({ size: '180x180', data: `${appUrl}/checkin/${params.registrationId}` });
  // & must be escaped as &amp; inside an HTML attribute, or some email clients mis-parse the URL
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?${qrParams.toString().replace(/&/g, '&amp;')}`;

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
            <p style="margin:0 0 6px;color:#D9C58A;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">You're registered</p>
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">${params.tournamentName}</h1>
            <p style="margin:10px 0 0;color:rgba(255,255,255,.75);font-size:14px;">${dateStr}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:32px 40px;border-left:1px solid #E5E0D5;border-right:1px solid #E5E0D5;">
            <p style="margin:0 0 20px;font-size:15px;color:#1A1F1C;line-height:1.6;">Hi ${params.contactName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#3A3F3C;line-height:1.6;">Your spot is confirmed. Here are your tournament details — keep this email handy for check-in day.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E5E0D5;border-bottom:1px solid #E5E0D5;margin-bottom:24px;">
              ${params.teamName ? detailRow('Team', params.teamName) : ''}
              ${detailRow('Foursome', `#${params.foursomeNumber}`)}
              ${params.startingHole ? detailRow('Starting hole', `${params.startingHole}`) : ''}
              ${params.locationName ? detailRow('Location', params.locationName) : ''}
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr><td align="center" style="padding:8px 0 4px;">
                <img src="${qrUrl}" width="140" height="140" alt="Check-in QR code" style="border:1px solid #E5E0D5;border-radius:10px;padding:8px;background:#fff;" />
              </td></tr>
              <tr><td align="center" style="font-size:12px;color:#6B7775;padding-top:6px;">Show this QR code at check-in</td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1A1F1C;text-transform:uppercase;letter-spacing:.06em;">What to bring</p>
            <ul style="margin:0 0 8px;padding-left:18px;font-size:14px;color:#3A3F3C;line-height:1.9;">
              <li>Your clubs (rentals may be limited)</li>
              <li>Golf shoes — soft spikes only</li>
              <li>Sunscreen and a water bottle</li>
              <li>This confirmation (printed or on your phone)</li>
            </ul>
            <p style="margin:16px 0 0;font-size:14px;color:#3A3F3C;line-height:1.6;">Check-in opens 30 minutes before shotgun start. Please arrive with your team.</p>
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

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: params.contactEmail, name: params.contactName }],
      }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach' },
      subject: `You're registered — ${params.tournamentName}`,
      content: [{ type: 'text/html', value: html }],
    }),
  });
}
