import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadFieldPace, runKitchenCheck } from '@/lib/pace/field';

function getAuthedSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined);
}
const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function requireOwner(req: NextRequest, tournamentId: string) {
  const { data: { user } } = await getAuthedSupabase(req).auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const service = getServiceSupabase();
  const { data: t } = await service.from('tournaments').select('organizer_id').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service, organizerId: user.id };
}

// GET — Module 9's organizer view: where every group is, how they're pacing,
// and when the last one gets in. Roster data, so it's organizer-only.
//
// Reading pace also runs the kitchen check. The notification is specified to
// need no human action, and an organizer watching this screen during play is
// the most reliable trigger there is — it costs one extra query and the unique
// index makes a duplicate impossible.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const field = await loadFieldPace(gate.service, id);
  if (!field) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });

  if (!field.kitchen) {
    // Best effort — a failing kitchen check must never blank the pace screen.
    try { await runKitchenCheck(gate.service, id); } catch { /* surfaced via `kitchen` next poll */ }
  }

  const fresh = await loadFieldPace(gate.service, id);
  return NextResponse.json(fresh ?? field);
}
