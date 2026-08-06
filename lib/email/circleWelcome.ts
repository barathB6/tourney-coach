// TourneyCircle opt-in confirmation — and the only delivery path for the
// player's preferences credential.
//
// The link in this email carries prefs_token. It is deliberately NOT returned
// from any API response keyed by a registration id, because organizers hold
// every registration id for their own event. Sending it to the player's own
// mailbox is what makes it a credential the organizer does not have.

export interface CircleWelcomeParams {
  toEmail: string;
  name: string | null;
  prefsUrl: string;
  radiusMiles: number;
  cadenceDays: number;
}

export async function sendCircleWelcomeEmail(p: CircleWelcomeParams): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { ok: false, error: 'Email is not configured (SENDGRID_API_KEY)' };

  const text = `${p.name ? `Hi ${p.name},` : 'Hi,'}

You're in TourneyCircle. From now on you'll hear about charity golf tournaments
near you — at most one every ${p.cadenceDays} days, within ${p.radiusMiles} miles of home.

Manage what you hear about, change the radius, or leave any time:
${p.prefsUrl}

Keep this link — it's yours. Organizers never see it, and they never see you:
they only ever get a count of how many golfers are in range, never a list.

— TourneyCoach`;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: p.toEmail, ...(p.name ? { name: p.name } : {}) }] }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach' },
      subject: "You're in TourneyCircle",
      content: [{ type: 'text/plain', value: text }],
    }),
  }).catch(() => null);

  if (!res) return { ok: false, error: 'Could not reach the email service' };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `SendGrid returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
  }
  return { ok: true };
}
