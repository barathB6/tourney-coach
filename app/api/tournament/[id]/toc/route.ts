import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadOperationsCenter } from '@/lib/toc/load';

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
  return { service };
}

// GET — the Operations Center for one tournament: both role libraries with
// their tasks resolved against the right clock, plus the five goals with live
// progress. Organizer-only; the underlying tables are service-role.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const snapshot = await loadOperationsCenter(gate.service, id);
  if (!snapshot) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  return NextResponse.json(snapshot);
}

// PUT — set the five tournament goals. Targets only; progress is always
// derived, so there is deliberately no way to write an "actual" here.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const num = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;

  const row = {
    tournament_id: id,
    player_goal: num(body?.playerGoal, 10_000),
    sponsorship_goal_cents: num(body?.sponsorshipGoalDollars, 10_000_000) === null
      ? null
      : (body.sponsorshipGoalDollars as number) * 100,
    donation_items_goal: num(body?.donationItemsGoal, 100_000),
    marketing_reach_goal: num(body?.marketingReachGoal, 10_000_000),
    volunteer_roles_goal: num(body?.volunteerRolesGoal, 500),
    updated_at: new Date().toISOString(),
  };

  const { error } = await gate.service
    .from('tournament_goals')
    .upsert(row, { onConflict: 'tournament_id' });
  if (error) {
    return NextResponse.json({ error: 'Could not save goals — run migration 039' }, { status: 500 });
  }

  const snapshot = await loadOperationsCenter(gate.service, id);
  return NextResponse.json(snapshot);
}
