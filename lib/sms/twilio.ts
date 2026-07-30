// SMS via Twilio's REST API, called with fetch rather than the SDK — same
// choice the SendGrid helpers in lib/email/ make, and it keeps a dependency out
// of the bundle for one HTTP POST.
//
// Configuration is optional on purpose. A tournament with no Twilio credentials
// still runs; the kitchen notification records that it could not send instead
// of throwing, so the organizer sees the truth rather than a silent nothing.

export interface SmsResult { ok: boolean; sid?: string; error?: string }

export function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER,
  );
}

// E.164 for a US number typed the way a golf pro actually types it:
// "(985) 555-0134", "985-555-0134", "9855550134". Anything already starting
// with + is passed through untouched. Returns null when it can't be trusted —
// better to report "no usable number" than to text a stranger.
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export async function sendSms(params: { to: string; body: string }): Promise<SmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    return { ok: false, error: 'SMS is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)' };
  }
  const to = toE164(params.to);
  if (!to) return { ok: false, error: `Not a usable phone number: ${params.to}` };

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: params.body }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.message || `Twilio returned ${res.status}` };
    return { ok: true, sid: data?.sid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'SMS send failed' };
  }
}
