import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Public: minimal registration count for the microsite's live progress
// widget. No PII — just a number, so it's safe to poll unauthenticated.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { count } = await getSupabase()
    .from('registrations')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', id);

  return NextResponse.json({ count: count ?? 0 }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
