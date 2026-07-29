import type { SupabaseClient } from '@supabase/supabase-js';
import { applyMaxScore, type MaxScoreRule } from '@/lib/scoring/leaderboard';
import { broadcastScoreUpdate } from '@/lib/realtime';

// Organizer score correction, in one place.
//
// Reached from the Registrations tab and from the AI coach's correct_score
// tool. A correction does NOT rewrite history: it appends a NEW
// score_submissions row (latest-wins, so it supersedes the old score on the
// leaderboard) and records an audit row in score_corrections naming who
// changed what, from what, and why. The same max-score rule a player
// submission gets is applied here too — a correction that skipped the cap
// would put a score on the board that no player could have posted.
//
// Callers MUST have already verified the caller owns the tournament.

export interface CorrectionResult {
  ok: boolean;
  strokesRecorded?: number;
  capped?: boolean;
  previousStrokes?: number | null;
  auditLogged?: boolean;
  error?: string;
}

export async function applyScoreCorrection(opts: {
  service: SupabaseClient;
  registrationId: string;
  tournamentId: string;
  courseId: string | null;
  maxScoreRule: MaxScoreRule | null;
  holeNumber: number;
  strokes: number;
  reason?: string | null;
  correctedBy: string;
}): Promise<CorrectionResult> {
  const { service, registrationId, tournamentId, courseId, holeNumber, strokes, correctedBy } = opts;

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

  let finalStrokes = strokes;
  let capped = false;
  if (opts.maxScoreRule && courseId) {
    const { data: hole } = await service
      .from('course_holes').select('par').eq('course_id', courseId).eq('hole_number', holeNumber).maybeSingle();
    const res = applyMaxScore(opts.maxScoreRule, hole?.par ?? null, strokes);
    finalStrokes = res.strokes;
    capped = res.capped;
  }

  const { data: inserted, error: insertErr } = await service
    .from('score_submissions')
    .insert({
      registration_id: registrationId,
      tournament_id: tournamentId,
      course_id: courseId,
      device_id: null, // organizer correction, not a device submission
      hole_number: holeNumber,
      strokes: finalStrokes,
      green_labeled_points: 0, // corrections don't label GPS
      submitted_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (insertErr || !inserted) return { ok: false, error: 'Failed to record correction' };

  const { error: auditErr } = await service.from('score_corrections').insert({
    score_submission_id: inserted.id,
    tournament_id: tournamentId,
    registration_id: registrationId,
    hole_number: holeNumber,
    old_strokes: prior?.strokes ?? null,
    new_strokes: finalStrokes,
    reason: typeof opts.reason === 'string' ? opts.reason.slice(0, 500) : null,
    corrected_by: correctedBy,
  });

  await broadcastScoreUpdate(tournamentId, { holeNumber, registrationId, correction: true });

  return {
    ok: true,
    strokesRecorded: finalStrokes,
    capped,
    previousStrokes: prior?.strokes ?? null,
    auditLogged: !auditErr,
  };
}
