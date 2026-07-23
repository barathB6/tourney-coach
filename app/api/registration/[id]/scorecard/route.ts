import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { latestScores, type ScoreRow } from '@/lib/scoring/leaderboard';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Read-only round review for one team (registration). Public by registration
// id, same as the Live Round page — a player reviews their own card via their
// round link. Shows the latest score per hole (corrections/resubmissions
// already collapsed by the engine's latest-wins) with par + running to-par.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabase();

  const { data: reg } = await supabase
    .from('registrations')
    .select('id, team_name, foursome_number, players, tournament_id, tournaments(id, name, course_id, status)')
    .eq('id', id)
    .maybeSingle();
  if (!reg) return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
  const t = reg.tournaments as unknown as { id: string; name: string; course_id: string | null; status: string } | null;
  // Same public-visibility rule as the board (service-role bypasses RLS): a
  // draft tournament's card stays private until it is published.
  if (!t || !['published', 'live', 'completed'].includes(t.status)) {
    return NextResponse.json({ error: 'Round not found' }, { status: 404 });
  }

  const [{ data: scores }, { data: holes }, { data: contests }] = await Promise.all([
    supabase.from('score_submissions').select('registration_id, hole_number, strokes, submitted_at').eq('registration_id', id),
    t?.course_id
      ? supabase.from('course_holes').select('hole_number, par').eq('course_id', t.course_id).order('hole_number')
      : Promise.resolve({ data: [] as { hole_number: number; par: number | null }[] }),
    t?.id
      ? supabase.from('contest_holes').select('hole_number, contest_type').eq('tournament_id', t.id)
      : Promise.resolve({ data: [] as { hole_number: number; contest_type: string }[] }),
  ]);

  const latest = latestScores((scores ?? []).map((s): ScoreRow => ({ registrationId: s.registration_id, holeNumber: s.hole_number, strokes: s.strokes, submittedAt: s.submitted_at })));
  const holeMap = latest.get(id) ?? new Map();
  const contestByHole = new Map<number, string[]>();
  for (const c of contests ?? []) { (contestByHole.get(c.hole_number) ?? contestByHole.set(c.hole_number, []).get(c.hole_number)!).push(c.contest_type); }

  let running = 0;
  let toParKnown = 0;
  const card = (holes ?? []).map((h) => {
    const row = holeMap.get(h.hole_number);
    const strokes = row?.strokes ?? null;
    if (strokes != null) {
      running += strokes;
      if (h.par != null) toParKnown += strokes - h.par;
    }
    return {
      holeNumber: h.hole_number, par: h.par, strokes,
      toPar: strokes != null && h.par != null ? strokes - h.par : null,
      runningToPar: strokes != null ? toParKnown : null,
      contests: contestByHole.get(h.hole_number) ?? [],
    };
  });

  const played = card.filter((c) => c.strokes != null).length;
  return NextResponse.json({
    // Public page — never fall back to a person's real contact name.
    team: { name: reg.team_name?.trim() || (reg.foursome_number != null ? `Foursome #${reg.foursome_number}` : 'Team'), players: Array.isArray(reg.players) ? (reg.players as { name?: string }[]).map((p) => p?.name).filter(Boolean) : [] },
    tournament: { id: t?.id ?? null, name: t?.name ?? null },
    card, holesPlayed: played, totalStrokes: running, toPar: played > 0 ? toParKnown : null,
  });
}
