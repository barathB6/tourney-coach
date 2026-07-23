import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { labelGreenOnScoreSubmission } from '@/lib/gps/labelGreen';
import { isDeviceConsented } from '@/lib/gps/consent';
import { applyMaxScore, type MaxScoreRule } from '@/lib/scoring/leaderboard';
import { broadcastScoreUpdate } from '@/lib/realtime';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Score submission — the trigger for the patent's inventive mechanism:
// "when a participant submits a score for hole N, the system captures the
// participant's contemporaneous GPS coordinates and labels them as the
// approximate green location for hole N." Clients flush their buffered GPS
// queue BEFORE posting here so the freshest points are server-side when
// labeling runs; they may also attach their current fix (currentLat/
// currentLng) which — consent permitting — is ingested as one more track
// point first, so labeling never depends on a race with the queue flush.
//
// Day 21 additions: the event's max-score rule is enforced server-side
// (pick-up-at-par clamps the recorded strokes and tells the UI to explain
// why), and every accepted score broadcasts on leaderboard:<tournamentId>
// so public leaderboards update in real time.
//
// Identity is the registered device token (players have no login). A known
// device may submit a score even if its GPS consent was later revoked —
// scores and location consent are separate concerns; labeling simply finds
// no fresh points for a revoked device because ingestion stopped.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { deviceToken, holeNumber, strokes, currentLat, currentLng, currentAccuracy } = body ?? {};

  if (typeof deviceToken !== 'string' || deviceToken.length < 10) {
    return NextResponse.json({ error: 'Missing deviceToken' }, { status: 400 });
  }
  if (typeof holeNumber !== 'number' || holeNumber < 1 || holeNumber > 18) {
    return NextResponse.json({ error: 'holeNumber must be 1-18' }, { status: 400 });
  }
  if (typeof strokes !== 'number' || !Number.isInteger(strokes) || strokes < 1 || strokes > 20) {
    return NextResponse.json({ error: 'strokes must be an integer 1-20' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: device } = await supabase
    .from('gps_devices')
    .select('id, registration_id, registrations(tournament_id, tournaments(course_id, max_score_rule))')
    .eq('device_token', deviceToken)
    .maybeSingle();
  if (!device) {
    return NextResponse.json({ error: 'Unknown device — open your round link and opt in first' }, { status: 403 });
  }

  const reg = device.registrations as unknown as {
    tournament_id: string;
    tournaments: { course_id: string | null; max_score_rule: MaxScoreRule | null } | null;
  } | null;
  const tournamentId = reg?.tournament_id ?? null;
  const courseId = reg?.tournaments?.course_id ?? null;
  const submittedAt = new Date();

  // Contemporaneous fix from the submitting phone (optional): ingested as a
  // normal track point — consent-gated exactly like /api/gps/track — so the
  // labeling below sees it even if the client's queue flush raced or failed.
  if (
    typeof currentLat === 'number' && currentLat >= -90 && currentLat <= 90 &&
    typeof currentLng === 'number' && currentLng >= -180 && currentLng <= 180 &&
    tournamentId && courseId &&
    (await isDeviceConsented(supabase, device.id))
  ) {
    await supabase.from('gps_tracks').insert({
      device_id: device.id,
      foursome_id: device.registration_id,
      tournament_id: tournamentId,
      course_id: courseId,
      hole_number: holeNumber,
      lat: currentLat,
      lng: currentLng,
      accuracy: typeof currentAccuracy === 'number' ? Math.min(9999.99, currentAccuracy) : null,
      recorded_at: submittedAt.toISOString(),
    });
  }

  // Max score rule (pick-up-at-par etc.): clamp server-side so the
  // leaderboard can trust stored strokes; tell the client when it happened
  // so the UI explains rather than silently rewriting the number.
  let finalStrokes = strokes;
  let capped = false;
  let cap: number | null = null;
  const rule = reg?.tournaments?.max_score_rule ?? null;
  if (rule && courseId) {
    const { data: hole } = await supabase
      .from('course_holes')
      .select('par')
      .eq('course_id', courseId)
      .eq('hole_number', holeNumber)
      .maybeSingle();
    const result = applyMaxScore(rule, hole?.par ?? null, strokes);
    finalStrokes = result.strokes;
    capped = result.capped;
    cap = result.capped ? result.strokes : null;
  }

  // The inventive step, live: label this submission's contemporaneous GPS
  // points as the green for this hole. Guarded so a labeling failure (e.g. a
  // transient network error to PostgREST) never sinks the score itself —
  // scoring and labeling are independent, as documented.
  let labelResult: { labeled: number; green: unknown } = { labeled: 0, green: null };
  try {
    labelResult = await labelGreenOnScoreSubmission({
      foursomeId: device.registration_id,
      holeNumber,
      scoreSubmittedAt: submittedAt,
    });
  } catch {
    // labeling failed; the score still persists below and reports greenLabeled:false
  }

  // Persist the score itself. Kept independent of labeling: if migration
  // 026 hasn't been applied yet the labeling above still ran — report both
  // outcomes honestly instead of failing the whole request.
  const { error: insertErr } = await supabase.from('score_submissions').insert({
    registration_id: device.registration_id,
    tournament_id: tournamentId,
    course_id: courseId,
    device_id: device.id,
    hole_number: holeNumber,
    strokes: finalStrokes,
    green_labeled_points: labelResult.labeled,
    submitted_at: submittedAt.toISOString(),
  });

  if (!insertErr && tournamentId) {
    await broadcastScoreUpdate(tournamentId, { holeNumber, registrationId: device.registration_id });
  }

  return NextResponse.json({
    scoreStored: !insertErr,
    ...(insertErr ? { scoreStoreError: 'score_submissions table unavailable — run db/migrations/026_score_submissions.sql' } : {}),
    strokesRecorded: finalStrokes,
    capped,
    ...(capped ? { cap } : {}),
    labeledPoints: labelResult.labeled,
    greenLabeled: labelResult.green != null,
  });
}
