import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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
  const result = await runDonationFollowups(getSupabase());
  return NextResponse.json({ ok: true, ...result });
}
