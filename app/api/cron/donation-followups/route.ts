import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { captureError, captureEvent } from '@/lib/observability/report';
import { runDonationFollowups } from '@/lib/donations/outreach';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Runs daily via Vercel Cron (see vercel.json). The cadence itself lives in
// lib/donations/outreach.ts so the same rules can be exercised by the test
// suite without an HTTP round trip — this route is only the trigger and the
// auth check.
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const started = Date.now();
  try {
    const result = await runDonationFollowups(getSupabase());
    captureEvent('cron completed', {
      scope: 'cron.donation-followups',
      detail: { ms: Date.now() - started, ...result },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    captureError(err, { scope: 'cron.donation-followups', detail: { ms: Date.now() - started } });
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, { status: 500 });
  }
}
