import { NextRequest, NextResponse } from 'next/server';
import { captureError, captureEvent, captureWarning } from '@/lib/observability/report';
import { getPublicAppUrl } from '@/lib/publicUrl';

export const dynamic = 'force-dynamic';

// The alerting half of monitoring. /api/health is a dashboard nobody watches;
// this is the thing that reaches a person.
//
// It runs daily, calls the health endpoint, and emails admin@ ONLY when the
// state is bad. That restraint is the whole design: an alert that arrives every
// day is an alert nobody reads by week two, and the one morning it matters it
// will be indistinguishable from the 300 that didn't.
//
// It also deliberately re-alerts each day while a fault persists, rather than
// once. A missing Twilio credential that has been broken for five days should
// keep saying so — the previous email is not proof anybody acted.

const ALERT_TO = process.env.ALERT_EMAIL?.trim() || 'admin@tourneycoach.com';

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
  const optional = health.failing.filter((f) => !f.critical);

  const text = `TourneyCoach health: ${health.status.toUpperCase()}

Environment: ${health.environment} (${health.commit})
Database:    ${health.latencyMs.database}ms

${critical.length ? `NEEDS ATTENTION NOW\n${critical.map((f) => `  • ${f.name}${f.note ? ` — ${f.note}` : ''}`).join('\n')}\n` : ''}${optional.length ? `DEGRADED\n${optional.map((f) => `  • ${f.name}${f.note ? ` — ${f.note}` : ''}`).join('\n')}\n` : ''}
Full report: ${appUrl}/api/health

This email is only sent when something is wrong, and it repeats daily until it
isn't. If you are seeing it, nobody has fixed the item above yet.`;

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

  captureWarning(`health is ${health.status}`, {
    scope: 'cron.health-alert',
    detail: { failing: health.failing.map((f) => f.name) },
  });
  const sent = await sendAlert(health, appUrl);
  if (!sent.ok) captureError(sent.error ?? 'alert send failed', { scope: 'cron.health-alert' });

  return NextResponse.json({
    status: health.status,
    alerted: sent.ok,
    failing: health.failing.map((f) => f.name),
    ...(sent.error ? { alertError: sent.error } : {}),
  });
}
