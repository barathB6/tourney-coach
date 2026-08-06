import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Public: minimal registration count for the microsite's live progress widget
// and the registration page's "spots remaining". No PII — just a number, so it
// is safe to poll unauthenticated.
//
// This is now the ONLY way the browser learns that number. The register page
// used to count the rows itself with the anon key, which is why the table
// carried an anon grant at all — and that grant turned out to expose every
// registration in the database (see migration 048).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Refunded entries are not holding a spot, and a cancelled entry that still
  // counted against capacity would keep a real player out.
  const { count } = await getSupabase()
    .from('registrations')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', id)
    .in('payment_status', ['pending', 'paid']);

  return NextResponse.json({ count: count ?? 0 }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
