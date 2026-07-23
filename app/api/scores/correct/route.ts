import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { applyMaxScore, type MaxScoreRule } from '@/lib/scoring/leaderboard';
import { broadcastScoreUpdate } from '@/lib/realtime';

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
  if (typeof holeNumber !== 'number' || holeNumber < 1 || holeNumber > 18) {
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

  // Prior recorded score for this hole (the latest existing submission), for
  // the audit trail's old→new record.
  const { data: prior } = await service
    .from('score_submissions')
    .select('strokes')
    .eq('registration_id', registrationId)
    .eq('hole_number', holeNumber)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Apply the same max-score rule a player submission would.
  let finalStrokes = strokes;
  let capped = false;
  if (t.max_score_rule && t.course_id) {
    const { data: hole } = await service
      .from('course_holes')
      .select('par')
      .eq('course_id', t.course_id)
      .eq('hole_number', holeNumber)
      .maybeSingle();
    const res = applyMaxScore(t.max_score_rule, hole?.par ?? null, strokes);
    finalStrokes = res.strokes;
    capped = res.capped;
  }

  const submittedAt = new Date().toISOString();
  const { data: inserted, error: insertErr } = await service
    .from('score_submissions')
    .insert({
      registration_id: registrationId,
      tournament_id: reg.tournament_id,
      course_id: t.course_id,
      device_id: null, // organizer correction, not a device submission
      hole_number: holeNumber,
      strokes: finalStrokes,
      green_labeled_points: 0, // corrections don't label GPS
      submitted_at: submittedAt,
    })
    .select('id')
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json({ error: 'Failed to record correction' }, { status: 500 });
  }

  const { error: auditErr } = await service.from('score_corrections').insert({
    score_submission_id: inserted.id,
    tournament_id: reg.tournament_id,
    registration_id: registrationId,
    hole_number: holeNumber,
    old_strokes: prior?.strokes ?? null,
    new_strokes: finalStrokes,
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    corrected_by: user.id,
  });

  await broadcastScoreUpdate(reg.tournament_id, { holeNumber, registrationId, correction: true });

  return NextResponse.json({
    ok: true,
    strokesRecorded: finalStrokes,
    capped,
    previousStrokes: prior?.strokes ?? null,
    auditLogged: !auditErr,
    ...(auditErr ? { auditError: 'score_corrections table unavailable — run db/migrations/028_live_scoring.sql' } : {}),
  });
}
