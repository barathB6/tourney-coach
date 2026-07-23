import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  computeStandings, recentFormFromHoleRows, latestScores,
  type ScoreRow, type TeamInfo, type HoleInfo, type TournamentFormat, type MaxScoreRule,
} from '@/lib/scoring/leaderboard';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// The rich public board payload for the TV leaderboard: standings (with the
// team's players + a real recent-form trend), committed sponsors with logos,
// the live fundraising total, and contest-hole status. Every number is
// real/derived — nothing invented. Public read via service-role, draft-gated
// exactly like the plain leaderboard.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabase();

  const { data: tournament } = await supabase
    .from('tournaments')
    .select('id, name, format, max_score_rule, status, course_id')
    .eq('id', id)
    .maybeSingle();
  if (!tournament) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  if (!['published', 'live', 'completed'].includes(tournament.status)) {
    return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  }

  const [{ data: regs }, { data: scores }, { data: holes }, { data: sponsors }, { data: contests }, { data: course }] = await Promise.all([
    supabase.from('registrations').select('id, team_name, contact_name, foursome_number, registration_type, players, total_amount_cents, payment_status').eq('tournament_id', id),
    supabase.from('score_submissions').select('registration_id, hole_number, strokes, submitted_at').eq('tournament_id', id),
    tournament.course_id
      ? supabase.from('course_holes').select('hole_number, par').eq('course_id', tournament.course_id)
      : Promise.resolve({ data: [] as { hole_number: number; par: number | null }[] }),
    supabase.from('sponsors').select('company, logo_url, amount_cents, status').eq('tournament_id', id),
    supabase.from('contest_holes').select('hole_number, contest_type, prize, winner_name, winner_detail, decided_at').eq('tournament_id', id).order('hole_number'),
    tournament.course_id
      ? supabase.from('courses').select('name').eq('id', tournament.course_id).maybeSingle()
      : Promise.resolve({ data: null as { name: string } | null }),
  ]);

  const playingRegs = (regs ?? []).filter((r) => r.registration_type !== 'sponsor');
  const teams: TeamInfo[] = playingRegs.map((r) => ({
    registrationId: r.id, teamName: r.team_name,
    contactName: r.foursome_number != null ? `Foursome #${r.foursome_number}` : 'Team',
    foursomeNumber: r.foursome_number,
  }));

  const scoreRows: ScoreRow[] = (scores ?? []).map((s) => ({
    registrationId: s.registration_id, holeNumber: s.hole_number, strokes: s.strokes, submittedAt: s.submitted_at,
  }));
  const holeInfo: HoleInfo[] = (holes ?? []).map((h) => ({ holeNumber: h.hole_number, par: h.par }));
  const pars = new Map<number, number>();
  for (const h of holeInfo) if (h.par != null) pars.set(h.holeNumber, h.par);

  const standings = computeStandings({
    format: tournament.format as TournamentFormat,
    maxScoreRule: tournament.max_score_rule as MaxScoreRule,
    teams, holes: holeInfo, scores: scoreRows,
  });

  // Player names + recent-form trend, joined onto each standing.
  const playersByReg = new Map<string, string[]>();
  for (const r of playingRegs) {
    const names = Array.isArray(r.players) ? (r.players as { name?: string }[]).map((p) => p?.name).filter((n): n is string => !!n) : [];
    playersByReg.set(r.id, names);
  }
  // Trend must run on LATEST-per-hole rows — corrections/resubmissions append
  // new score rows, so raw rows would double-count a corrected hole and count
  // a value the correction already superseded.
  const latestByTeam = latestScores(scoreRows);
  const enriched = standings.map((s) => ({
    ...s,
    players: playersByReg.get(s.registrationId) ?? [],
    trend: recentFormFromHoleRows([...(latestByTeam.get(s.registrationId)?.values() ?? [])], pars, 3),
  }));

  // Committed sponsors with a logo, for the rotating corner display.
  const sponsorLogos = (sponsors ?? [])
    .filter((sp) => sp.status === 'paid' && sp.logo_url)
    .map((sp) => ({ company: sp.company as string, logoUrl: sp.logo_url as string }));

  // Live fundraising total — REAL money only: every paid registration
  // (including sponsor-type foursome packages, which are NOT playing teams but
  // ARE real money) plus paid sponsors from the sponsors table.
  const entryRaised = (regs ?? []).filter((r) => r.payment_status === 'paid').reduce((sum, r) => sum + (r.total_amount_cents ?? 0), 0);
  const sponsorRaised = (sponsors ?? []).filter((sp) => sp.status === 'paid').reduce((sum, sp) => sum + (sp.amount_cents ?? 0), 0);

  const parTotal = holeInfo.reduce((sum, h) => sum + (h.par ?? 0), 0) || null;

  return NextResponse.json({
    tournament: {
      id: tournament.id, name: tournament.name, format: tournament.format,
      maxScoreRule: tournament.max_score_rule, status: tournament.status, parTotal,
      course: course?.name ?? null,
    },
    standings: enriched,
    teamsTotal: teams.length,
    sponsors: sponsorLogos,
    contests: (contests ?? []).map((c) => ({
      holeNumber: c.hole_number, type: c.contest_type, prize: c.prize,
      winner: c.winner_name, detail: c.winner_detail, decided: !!c.decided_at,
    })),
    raisedCents: entryRaised + sponsorRaised,
    updatedAt: new Date().toISOString(),
  });
}
