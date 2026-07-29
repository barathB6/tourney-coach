// Sends the head pro their course-editing link and issued password. The
// password is included deliberately: it's system-issued (never user-chosen,
// never reused elsewhere), scoped to one course profile, and the alternative
// — the organizer reading it down the phone — is what this replaces.
export async function sendProAccessInviteEmail(params: {
  toEmail: string;
  courseName: string;
  organizerName: string | null;
  loginUrl: string;
  password: string;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return; // SendGrid not configured yet — skip silently

  const from = params.organizerName ? `${params.organizerName} has` : 'A tournament organizer has';

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FAF8F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F3;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#1B4425;border-radius:14px 14px 0 0;padding:36px 40px;text-align:center;">
            <p style="margin:0 0 6px;color:#D9C58A;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Course profile access</p>
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">${params.courseName}</h1>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:32px 40px;border-left:1px solid #E5E0D5;border-right:1px solid #E5E0D5;">
            <p style="margin:0 0 20px;font-size:15px;color:#3A3F3C;line-height:1.6;">${from} asked you to confirm the hole data for <strong>${params.courseName}</strong> — par, yardages by tee, handicap, and hole layout.</p>
            <p style="margin:0 0 24px;font-size:15px;color:#3A3F3C;line-height:1.6;">Everything is pre-filled with typical distances, so this is a review-and-correct pass, not data entry from scratch. Most pros finish in about 25 minutes.</p>

            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F5EE;border:1px solid #E5E0D5;border-radius:10px;margin-bottom:24px;">
              <tr><td style="padding:18px 20px;">
                <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#6B7775;text-transform:uppercase;letter-spacing:.06em;">Your sign-in</p>
                <p style="margin:0 0 10px;font-size:14px;color:#1A1F1C;">Email: <strong>${params.toEmail}</strong></p>
                <p style="margin:0;font-size:11px;font-weight:700;color:#6B7775;text-transform:uppercase;letter-spacing:.06em;">Password</p>
                <p style="margin:2px 0 0;font-size:20px;color:#1B6B3A;font-weight:700;font-family:'SF Mono',Menlo,monospace;">${params.password}</p>
              </td></tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
              <a href="${params.loginUrl}" style="display:inline-block;background:#1B6B3A;color:#ffffff;font-weight:700;font-size:15px;padding:13px 30px;border-radius:6px;text-decoration:none;">Open the course profile</a>
            </td></tr></table>
            <p style="margin:14px 0 0;font-size:12px;color:#9BA8A4;text-align:center;line-height:1.6;">This link is unique to you. Please don't forward it — anyone with the link and password can edit this course.</p>
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
      personalizations: [{ to: [{ email: params.toEmail }] }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach' },
      subject: `Confirm the hole data for ${params.courseName} (about 25 minutes)`,
      content: [{ type: 'text/html', value: html }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`SendGrid send failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
}
