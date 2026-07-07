import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getSupabase();

  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.slice(7));
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: reg } = await supabase
    .from('registrations')
    .select('id, tournament_id, checked_in_at, tournaments(organizer_id)')
    .eq('id', id)
    .single();

  if (!reg) {
    return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
  }
  const tournament = reg.tournaments as unknown as { organizer_id: string } | null;
  if (tournament?.organizer_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (reg.checked_in_at) {
    return NextResponse.json({ error: 'Already checked in', checked_in_at: reg.checked_in_at }, { status: 409 });
  }

  const checked_in_at = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('registrations')
    .update({ checked_in_at })
    .eq('id', id);

  if (updateErr) {
    return NextResponse.json({ error: 'Failed to check in' }, { status: 500 });
  }

  return NextResponse.json({ checked_in_at });
}
