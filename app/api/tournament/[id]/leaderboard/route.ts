import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { computeStandings, type ScoreRow, type TeamInfo, type HoleInfo, type TournamentFormat, type MaxScoreRule } from '@/lib/scoring/leaderboard';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Public live leaderboard. Service-role read (score_submissions is locked to
// service-role like every scoring table), computed fresh on each request from
// the append-only score rows — the pure engine in lib/scoring picks the
// latest score per (team, hole) and ranks by to-par with USGA countback.
// The public leaderboard page subscribes to realtime pushes AND polls this
// endpoint as a fallback.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabase();

  const { data: tournament } = await supabase
    .from('tournaments')
    .select('id, name, format, max_score_rule, status, course_id')
    .eq('id', id)
    .maybeSingle();
  if (!tournament) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  // This is a PUBLIC endpoint via the service-role client, which bypasses RLS
  // — so re-apply the same visibility rule the tournaments RLS policy enforces
  // (migration 002): a draft tournament's roster and scores must stay private.
  if (!['published', 'live', 'completed'].includes(tournament.status)) {
    return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  }

  const [{ data: regs }, { data: scores }, { data: holes }] = await Promise.all([
    supabase.from('registrations')
      .select('id, team_name, contact_name, foursome_number, registration_type')
      .eq('tournament_id', id),
    supabase.from('score_submissions')
      .select('registration_id, hole_number, strokes, submitted_at')
      .eq('tournament_id', id),
    tournament.course_id
      ? supabase.from('course_holes').select('hole_number, par').eq('course_id', tournament.course_id)
      : Promise.resolve({ data: [] as { hole_number: number; par: number | null }[] }),
  ]);

  // Sponsor "registrations" aren't playing teams — keep them off the board.
  const teams: TeamInfo[] = (regs ?? [])
    .filter((r) => r.registration_type !== 'sponsor')
    .map((r) => ({
      registrationId: r.id,
      teamName: r.team_name,
      // Public page — never fall back to a person's real contact name. Use a
      // neutral foursome label when no team name was set.
      contactName: r.foursome_number != null ? `Foursome #${r.foursome_number}` : 'Team',
      foursomeNumber: r.foursome_number,
    }));

  const scoreRows: ScoreRow[] = (scores ?? []).map((s) => ({
    registrationId: s.registration_id,
    holeNumber: s.hole_number,
    strokes: s.strokes,
    submittedAt: s.submitted_at,
  }));

  const holeInfo: HoleInfo[] = (holes ?? []).map((h) => ({ holeNumber: h.hole_number, par: h.par }));

  const standings = computeStandings({
    format: tournament.format as TournamentFormat,
    maxScoreRule: tournament.max_score_rule as MaxScoreRule,
    teams,
    holes: holeInfo,
    scores: scoreRows,
  });

  const parTotal = holeInfo.reduce((sum, h) => sum + (h.par ?? 0), 0) || null;

  return NextResponse.json({
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      maxScoreRule: tournament.max_score_rule,
      status: tournament.status,
      parTotal,
    },
    standings,
    teamsTotal: teams.length,
    updatedAt: new Date().toISOString(),
  });
}
