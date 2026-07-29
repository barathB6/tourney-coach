import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { type MaxScoreRule } from '@/lib/scoring/leaderboard';
import { applyScoreCorrection } from '@/lib/scoring/correct';

// RLS-respecting client carrying the caller's token — used to prove the
// caller owns the tournament before any correction is written.
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

// Organizer score correction. A correction does NOT rewrite history: it
// appends a NEW score_submissions row (latest-wins, so it supersedes the old
// score on the leaderboard) and records an audit row in score_corrections
// naming who changed what, from what, and why. Same max-score rule applies as
// a player submission. Broadcasts so the public board updates live.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { registrationId, holeNumber, strokes, reason } = body ?? {};

  if (typeof registrationId !== 'string') {
    return NextResponse.json({ error: 'Missing registrationId' }, { status: 400 });
  }
  if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
    return NextResponse.json({ error: 'holeNumber must be 1-18' }, { status: 400 });
  }
  if (typeof strokes !== 'number' || !Number.isInteger(strokes) || strokes < 1 || strokes > 20) {
    return NextResponse.json({ error: 'strokes must be an integer 1-20' }, { status: 400 });
  }

  const authed = getAuthedSupabase(req);
  const { data: { user }, error: authErr } = await authed.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = getServiceSupabase();

  // Resolve the team → its tournament, and confirm the caller owns it.
  const { data: reg } = await service
    .from('registrations')
    .select('id, tournament_id, tournaments(organizer_id, course_id, max_score_rule)')
    .eq('id', registrationId)
    .maybeSingle();
  if (!reg) return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
  const t = reg.tournaments as unknown as { organizer_id: string; course_id: string | null; max_score_rule: MaxScoreRule | null } | null;
  if (!t || t.organizer_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden — you do not own this tournament' }, { status: 403 });
  }

  const result = await applyScoreCorrection({
    service,
    registrationId,
    tournamentId: reg.tournament_id,
    courseId: t.course_id,
    maxScoreRule: t.max_score_rule as MaxScoreRule | null,
    holeNumber,
    strokes,
    reason,
    correctedBy: user.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  return NextResponse.json({
    ok: true,
    strokesRecorded: result.strokesRecorded,
    capped: result.capped,
    previousStrokes: result.previousStrokes ?? null,
    auditLogged: result.auditLogged,
    ...(result.auditLogged ? {} : { auditError: 'score_corrections table unavailable — run db/migrations/028_live_scoring.sql' }),
  });
}
