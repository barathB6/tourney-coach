import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TEAM_SIZE = 4;

// Public: list teams for a tournament with open slots (used by "join existing team")
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('registrations')
    .select('team_name, players')
    .eq('tournament_id', id)
    .in('payment_status', ['pending', 'paid'])
    .not('team_name', 'is', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = new Map<string, number>();
  for (const r of data ?? []) {
    const n = Array.isArray(r.players) ? r.players.length : 0;
    counts.set(r.team_name, (counts.get(r.team_name) ?? 0) + n);
  }

  const teams = [...counts.entries()]
    .map(([name, players]) => ({ team_name: name, players, spots_left: Math.max(0, TEAM_SIZE - players) }))
    .filter(t => t.spots_left > 0)
    .sort((a, b) => a.team_name.localeCompare(b.team_name));

  return NextResponse.json({ teams });
}
