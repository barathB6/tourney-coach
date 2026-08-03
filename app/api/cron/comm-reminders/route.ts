import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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
  const result = await runCadence(getSupabase());
  return NextResponse.json({ ok: true, ...result });
}
