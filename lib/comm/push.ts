// Web Push via the `web-push` library and VAPID keys.
//
// Same honesty contract as Twilio (lib/sms/twilio): unconfigured is a normal
// state, not an exception. A send with no VAPID keys or no subscriptions
// reports why, and the comm engine falls back down its channel ladder.

import webpush from 'web-push';

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export interface PushResult { ok: boolean; delivered: number; gone: string[]; error?: string }

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let vapidSet = false;
function ensureVapid(): boolean {
  if (!pushConfigured()) return false;
  if (!vapidSet) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@tourneycoach.com',
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
    vapidSet = true;
  }
  return true;
}

/**
 * Push to every registration this person has. Success = at least one landed.
 * 404/410 endpoints are reported back as `gone` so the caller can prune them —
 * browsers silently invalidate subscriptions all the time.
 */
export async function sendWebPush(
  subs: PushSub[],
  payload: { title: string; body: string; url?: string },
): Promise<PushResult> {
  if (!ensureVapid()) return { ok: false, delivered: 0, gone: [], error: 'Push is not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)' };
  if (!subs.length) return { ok: false, delivered: 0, gone: [], error: 'No push subscriptions for this recipient' };

  let delivered = 0;
  const gone: string[] = [];
  let lastError: string | undefined;

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600 },
      );
      delivered++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
      else lastError = err instanceof Error ? err.message : 'push failed';
    }
  }

  return {
    ok: delivered > 0,
    delivered,
    gone,
    error: delivered > 0 ? undefined : (lastError ?? (gone.length ? 'All subscriptions have expired' : 'push failed')),
  };
}
