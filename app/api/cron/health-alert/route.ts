import { NextRequest, NextResponse } from 'next/server';
import { captureError, captureEvent, captureWarning } from '@/lib/observability/report';
import { getPublicAppUrl } from '@/lib/publicUrl';

export const dynamic = 'force-dynamic';

// The alerting half of monitoring. /api/health is a dashboard nobody watches;
// this is the thing that reaches a person.
//
// It runs daily, calls the health endpoint, and emails admin@ ONLY when there
// is something a person should ACT on. That last word is the whole design.
// The first version emailed on any `degraded` and repeated daily until fixed —
// which turned into a daily email about three limitations that are
// account-blocked and will not change until someone opens Twilio's or
// SendGrid's dashboard. An alert that repeats about a thing you have already
// decided to live with is noise, and noise is how the one email that matters
// gets ignored.
//
// So a non-critical check can be ACKNOWLEDGED: still shown truthfully on
// /api/health, but it no longer, by itself, triggers the daily email. The
// alert now fires only when a CRITICAL check fails (the site is actually
// broken) or a non-critical check fails that is NOT acknowledged (something
// new). Fixing an acknowledged item makes its check pass, so it drops off on
// its own — acknowledgement is "we know, stop nagging", never "hide it".

const ALERT_TO = process.env.ALERT_EMAIL?.trim() || 'admin@tourneycoach.com';

// Known, accepted, account-blocked degradations. Each needs a credential or a
// third-party dashboard the platform cannot reach itself, so daily-nagging
// about them reaches nobody who can act during a normal day.
//   sms (Twilio)               → needs a Twilio account + A2P 10DLC
//   sendgrid webhook signing   → needs SendGrid's Signed Event Webhook enabled
//   email open tracking        → needs the SendGrid Event Webhook pointed at us
// Add more at runtime with HEALTH_ALERT_MUTE (comma-separated check names) —
// no deploy needed. NEVER put a critical check here; criticals always alert.
const ACKNOWLEDGED = new Set(
  [
    'sms (Twilio)',
    'sendgrid webhook signing',
    'email open tracking',
    ...(process.env.HEALTH_ALERT_MUTE?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  ],
);

interface HealthPayload {
  status: 'ok' | 'degraded' | 'down';
  environment: string;
  commit: string;
  latencyMs: { database: number; total: number };
  failing: { name: string; critical: boolean; note?: string }[];
}

async function sendAlert(health: HealthPayload, appUrl: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { ok: false, error: 'SENDGRID_API_KEY is not set — the alert has nowhere to go' };

  const critical = health.failing.filter((f) => f.critical);
  // The reason for THIS email: unacknowledged, non-critical failures.
  const newlyWrong = health.failing.filter((f) => !f.critical && !ACKNOWLEDGED.has(f.name));
  // Acknowledged items are shown as context only, never as the reason.
  const known = health.failing.filter((f) => !f.critical && ACKNOWLEDGED.has(f.name));

  const line = (f: { name: string; note?: string }) => `  • ${f.name}${f.note ? ` — ${f.note}` : ''}`;
  const text = `TourneyCoach health: ${health.status.toUpperCase()}

Environment: ${health.environment} (${health.commit})
Database:    ${health.latencyMs.database}ms

${critical.length ? `NEEDS ATTENTION NOW\n${critical.map(line).join('\n')}\n\n` : ''}${newlyWrong.length ? `NEW SINCE THIS WAS LAST HEALTHY\n${newlyWrong.map(line).join('\n')}\n\n` : ''}${known.length ? `Known limitations (acknowledged — not why you got this email):\n${known.map(line).join('\n')}\n\n` : ''}Full report: ${appUrl}/api/health

You are getting this because a critical or NEW problem appeared. Known,
accepted limitations no longer trigger this email — mute more with the
HEALTH_ALERT_MUTE env var, or fix one and it drops off on its own.`;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: ALERT_TO }] }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach Monitoring' },
      subject: `${health.status === 'down' ? '🔴' : '🟡'} TourneyCoach ${health.status} — ${health.failing.map((f) => f.name).slice(0, 3).join(', ')}`,
      content: [{ type: 'text/plain', value: text }],
    }),
  }).catch(() => null);

  if (!res) return { ok: false, error: 'Could not reach the email service' };
  if (!res.ok) return { ok: false, error: `SendGrid returned ${res.status}` };
  return { ok: true };
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const appUrl = getPublicAppUrl();
  let health: HealthPayload;
  try {
    // Ask over HTTP rather than importing the handler, so this also proves the
    // deployment is serving requests at all — an in-process call would pass
    // happily while the site was returning 500s to everyone else.
    const res = await fetch(`${appUrl}/api/health`, { cache: 'no-store' });
    health = await res.json();
  } catch (err) {
    // The health endpoint being unreachable IS the alert.
    captureError(err, { scope: 'cron.health-alert', detail: { appUrl } });
    const fallback: HealthPayload = {
      status: 'down', environment: process.env.VERCEL_ENV ?? 'unknown', commit: 'unknown',
      latencyMs: { database: -1, total: -1 },
      failing: [{ name: 'health endpoint', critical: true, note: 'unreachable' }],
    };
    const sent = await sendAlert(fallback, appUrl);
    return NextResponse.json({ status: 'down', alerted: sent.ok, error: sent.error }, { status: 200 });
  }

  if (health.status === 'ok') {
    captureEvent('health ok', { scope: 'cron.health-alert', detail: { dbMs: health.latencyMs.database } });
    return NextResponse.json({ status: 'ok', alerted: false });
  }

  // Is there anything a person should ACT on? A critical failure always
  // qualifies; a non-critical one only if it isn't already acknowledged.
  const actionable = health.failing.filter((f) => f.critical || !ACKNOWLEDGED.has(f.name));

  if (actionable.length === 0) {
    // Degraded, but only by things we've already accepted. Record it so the
    // state is still in the log, and send nothing — this is the fix for the
    // daily-noise complaint: known limitations no longer reach the inbox.
    captureEvent('health degraded — only acknowledged limitations, no alert sent', {
      scope: 'cron.health-alert',
      detail: { acknowledged: health.failing.map((f) => f.name) },
    });
    return NextResponse.json({
      status: health.status,
      alerted: false,
      reason: 'only acknowledged limitations failing',
      acknowledged: health.failing.map((f) => f.name),
    });
  }

  captureWarning(`health is ${health.status} — ${actionable.length} actionable`, {
    scope: 'cron.health-alert',
    detail: { actionable: actionable.map((f) => f.name) },
  });
  const sent = await sendAlert(health, appUrl);
  if (!sent.ok) captureError(sent.error ?? 'alert send failed', { scope: 'cron.health-alert' });

  return NextResponse.json({
    status: health.status,
    alerted: sent.ok,
    actionable: actionable.map((f) => f.name),
    ...(sent.error ? { alertError: sent.error } : {}),
  });
}
