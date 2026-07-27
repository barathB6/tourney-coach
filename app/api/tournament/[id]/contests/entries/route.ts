import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { broadcastContestUpdate } from '@/lib/realtime';

function getAuthedSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}
const getServiceSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function requireOwner(req: NextRequest, tournamentId: string): Promise<{ service: SupabaseClient } | { error: NextResponse }> {
  const { data: { user } } = await getAuthedSupabase(req).auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const service = getServiceSupabase();
  const { data: t } = await service.from('tournaments').select('organizer_id').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service };
}

// Confirm a contest hole exists AND belongs to this tournament (so an owner of
// tournament A can't attach entries to tournament B's contest).
async function contestInTournament(service: SupabaseClient, contestHoleId: string, tournamentId: string): Promise<boolean> {
  const { data } = await service.from('contest_holes').select('tournament_id').eq('id', contestHoleId).maybeSingle();
  return !!data && data.tournament_id === tournamentId;
}

// POST — record a leaderboard entry (closest-to-pin / long-drive measurement) or
// register a putting entrant (value omitted).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const playerName = typeof body?.playerName === 'string' ? body.playerName.trim().slice(0, 120) : '';
  if (!body || typeof body.contestHoleId !== 'string' || !playerName) {
    return NextResponse.json({ error: 'contestHoleId and playerName are required' }, { status: 400 });
  }
  let valueInches: number | null = null;
  if (body.valueInches !== null && body.valueInches !== undefined && body.valueInches !== '') {
    const n = Number(body.valueInches);
    if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: 'valueInches must be a non-negative number' }, { status: 400 });
    valueInches = Math.round(n);
  }

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  if (!(await contestInTournament(gate.service, body.contestHoleId, id))) {
    return NextResponse.json({ error: 'Contest not found for this tournament' }, { status: 404 });
  }

  const { data, error } = await gate.service.from('contest_entries').insert({
    contest_hole_id: body.contestHoleId,
    registration_id: typeof body.registrationId === 'string' ? body.registrationId : null,
    player_name: playerName,
    category: typeof body.category === 'string' && body.category.trim() ? body.category.trim().slice(0, 60) : null,
    value_inches: valueInches,
    raw_label: typeof body.rawLabel === 'string' ? body.rawLabel.slice(0, 60) : null,
  }).select('id').maybeSingle();

  if (error) return NextResponse.json({ error: 'Failed to save entry (has migration 031 been run?)' }, { status: 500 });
  await broadcastContestUpdate(id, { kind: 'entry', contestId: body.contestHoleId });
  return NextResponse.json({ ok: true, id: data?.id });
}

// DELETE ?id=<entryId> — remove one entry (owner-checked via its contest).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entryId = new URL(req.url).searchParams.get('id') ?? '';
  if (!entryId) return NextResponse.json({ error: 'Entry id required' }, { status: 400 });

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const { data: entry } = await gate.service.from('contest_entries').select('contest_hole_id').eq('id', entryId).maybeSingle();
  if (!entry) return NextResponse.json({ ok: true }); // already gone
  if (!(await contestInTournament(gate.service, entry.contest_hole_id as string, id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await gate.service.from('contest_entries').delete().eq('id', entryId);
  await broadcastContestUpdate(id, { kind: 'entry', contestId: entry.contest_hole_id });
  return NextResponse.json({ ok: true });
}
