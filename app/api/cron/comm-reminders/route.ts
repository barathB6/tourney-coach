import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { captureError, captureEvent } from '@/lib/observability/report';
import { runCadence } from '@/lib/comm/runCadence';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Daily via Vercel Cron (Hobby allows nothing faster). The cadence itself is
// frequency-agnostic — a daily run reliably lands the 7d/48h/24h slots; the
// 6h/30m slots also fire from the organizer's "run reminders now" button and
// should be triggered alongside day-of pace polling. See lib/comm/runCadence.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const started = Date.now();
  try {
    const result = await runCadence(getSupabase());
    // Failures inside the sweep are per-volunteer and already reported by
    // sendComm; this is the run-level record — "did the cadence run at all,
    // and did it find anybody" — which is what you check when a volunteer says
    // they never got a reminder.
    captureEvent('cron completed', {
      scope: 'cron.comm-reminders',
      detail: { ms: Date.now() - started, tournaments: result.tournaments, considered: result.considered, sent: result.sent, failed: result.failed, alreadyClaimed: result.alreadyClaimed },
    });
    if (result.failed > 0) {
      captureError(`${result.failed} reminder(s) failed to send`, {
        scope: 'cron.comm-reminders',
        detail: { failedChannels: result.details.filter((d) => !d.ok).map((d) => d.channel) },
      });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    captureError(err, { scope: 'cron.comm-reminders', detail: { ms: Date.now() - started } });
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, { status: 500 });
  }
}
