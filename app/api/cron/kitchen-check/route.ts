import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runKitchenCheck } from '@/lib/pace/field';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Safety net for the kitchen notification (see vercel.json).
//
// The primary trigger is a score submission — pace only moves when groups post
// holes, so that fires naturally and often during a round. This exists for the
// case that trigger can't cover: the last group stops posting (phone dead, or
// they're just slow), elapsed time keeps climbing, and the estimate crosses 45
// minutes with no score to prompt a re-check.
//
// Scoped to tournaments played TODAY, so it never touches history.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data: live } = await supabase
    .from('tournaments')
    .select('id, name')
    .eq('event_date', today)
    .eq('status', 'published');

  const results: { tournament: string; fired: boolean; reason: string }[] = [];
  for (const t of live ?? []) {
    try {
      const r = await runKitchenCheck(supabase, t.id as string);
      results.push({ tournament: t.name as string, fired: r.fired, reason: r.reason });
    } catch (e) {
      results.push({ tournament: t.name as string, fired: false, reason: e instanceof Error ? e.message : 'check failed' });
    }
  }

  return NextResponse.json({ checked: results.length, fired: results.filter((r) => r.fired).length, results });
}
