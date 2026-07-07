import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Public: tells the registration form whether an email belongs to a
// returning member (waives the 2.5% new-member fee). Existence-only check —
// no profile data is returned, so this can't be used to enumerate players.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email')?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  const { data } = await getSupabase()
    .from('player_profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  return NextResponse.json({ returning: !!data });
}
