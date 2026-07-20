import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { labelGreenOnScoreSubmission } from '@/lib/gps/labelGreen';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Score submission — the trigger for the patent's inventive mechanism:
// "when a participant submits a score for hole N, the system captures the
// participant's contemporaneous GPS coordinates and labels them as the
// approximate green location for hole N." labelGreenOnScoreSubmission()
// was built complete-but-unwired while no scoring surface existed; this
// route is its caller. Clients flush their buffered GPS queue BEFORE
// posting here so the freshest points are server-side when labeling runs.
//
// Identity is the consented device token (players have no login). A known
// device may submit a score even if its GPS consent was later revoked —
// scores and location consent are separate concerns; labeling simply finds
// no fresh points for a revoked device because ingestion stopped.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { deviceToken, holeNumber, strokes } = body ?? {};

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
    .select('id, registration_id, registrations(tournament_id, tournaments(course_id))')
    .eq('device_token', deviceToken)
    .maybeSingle();
  if (!device) {
    return NextResponse.json({ error: 'Unknown device — open your round link and opt in first' }, { status: 403 });
  }

  const reg = device.registrations as unknown as { tournament_id: string; tournaments: { course_id: string | null } | null } | null;
  const submittedAt = new Date();

  // The inventive step, live: label this submission's contemporaneous GPS
  // points as the green for this hole.
  const labelResult = await labelGreenOnScoreSubmission({
    foursomeId: device.registration_id,
    holeNumber,
    scoreSubmittedAt: submittedAt,
  });

  // Persist the score itself. Kept independent of labeling: if migration
  // 026 hasn't been applied yet the labeling above still ran — report both
  // outcomes honestly instead of failing the whole request.
  const { error: insertErr } = await supabase.from('score_submissions').insert({
    registration_id: device.registration_id,
    tournament_id: reg?.tournament_id ?? null,
    course_id: reg?.tournaments?.course_id ?? null,
    device_id: device.id,
    hole_number: holeNumber,
    strokes,
    green_labeled_points: labelResult.labeled,
    submitted_at: submittedAt.toISOString(),
  });

  return NextResponse.json({
    scoreStored: !insertErr,
    ...(insertErr ? { scoreStoreError: 'score_submissions table unavailable — run db/migrations/026_score_submissions.sql' } : {}),
    labeledPoints: labelResult.labeled,
    greenLabeled: labelResult.green != null,
  });
}
