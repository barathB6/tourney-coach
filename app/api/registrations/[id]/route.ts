import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Organizer-only manual delete — e.g. removing a duplicate/test registration.
// Does NOT touch Adyen — if the registration is paid, the organizer should
// refund via /api/payments/refund first, since deleting here only removes
// the DB row and leaves any captured payment untouched.
export async function DELETE(
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
    .select('id, payment_status, tournaments(organizer_id)')
    .eq('id', id)
    .single();

  if (!reg) {
    return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
  }
  const tournament = reg.tournaments as unknown as { organizer_id: string } | null;
  if (tournament?.organizer_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (reg.payment_status === 'paid') {
    return NextResponse.json(
      { error: 'This registration is paid. Refund it first, then delete.' },
      { status: 409 }
    );
  }

  const { error: deleteErr } = await supabase
    .from('registrations')
    .delete()
    .eq('id', id);

  if (deleteErr) {
    return NextResponse.json({ error: 'Failed to delete registration' }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
