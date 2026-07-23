import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

const TYPES = ['hole_in_one', 'closest_to_pin', 'long_drive'];

async function requireOwner(req: NextRequest, tournamentId: string) {
  const authed = getAuthedSupabase(req);
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const service = getServiceSupabase();
  const { data: t } = await service.from('tournaments').select('organizer_id').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service, user };
}

// Organizer-owned contest management. POST upserts a contest hole (which hole,
// which type, prize) and/or records a winner. GET lists them for the config UI.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  const { data } = await gate.service.from('contest_holes').select('*').eq('tournament_id', id).order('hole_number');
  return NextResponse.json({ contests: data ?? [] });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { holeNumber, contestType, prize, winnerName, winnerDetail } = body ?? {};
  if (typeof holeNumber !== 'number' || holeNumber < 1 || holeNumber > 18) {
    return NextResponse.json({ error: 'holeNumber must be 1-18' }, { status: 400 });
  }
  if (!TYPES.includes(contestType)) {
    return NextResponse.json({ error: `contestType must be one of ${TYPES.join(', ')}` }, { status: 400 });
  }

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const hasWinner = typeof winnerName === 'string' && winnerName.trim().length > 0;
  const { error } = await gate.service.from('contest_holes').upsert({
    tournament_id: id,
    hole_number: holeNumber,
    contest_type: contestType,
    prize: typeof prize === 'string' ? prize.slice(0, 200) : null,
    winner_name: hasWinner ? winnerName.trim().slice(0, 120) : null,
    winner_detail: typeof winnerDetail === 'string' ? winnerDetail.slice(0, 120) : null,
    decided_at: hasWinner ? new Date().toISOString() : null,
  }, { onConflict: 'tournament_id,hole_number,contest_type' });

  if (error) {
    return NextResponse.json({ error: 'Failed to save contest (has migration 029 been run?)' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const holeNumber = Number(searchParams.get('hole'));
  const contestType = searchParams.get('type') ?? '';
  if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18 || !TYPES.includes(contestType)) {
    return NextResponse.json({ error: 'Valid hole (1-18) and contest type required' }, { status: 400 });
  }
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  await gate.service.from('contest_holes').delete().eq('tournament_id', id).eq('hole_number', holeNumber).eq('contest_type', contestType);
  return NextResponse.json({ ok: true });
}
