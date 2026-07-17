import { createClient } from '@supabase/supabase-js';
import { centroid, type LatLng } from './geo';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MATCH_WINDOW_MS = 3 * 60_000; // score submission usually happens within a few minutes of holing out
const FULL_FOURSOME = 4;

export interface LabelGreenResult {
  labeled: number;
  green: LatLng | null;
}

// Patent mechanism, green half (the headline claim): "when a player submits
// score for hole N → tag current position as green for hole N." Scoring
// happens after holing out, not before, so the submitting group's most
// recent GPS pings are, with very high confidence, at or near the green.
// That single behavioral signal labels the green location with zero manual
// survey work from the organizer or golf pro.
//
// Fully implemented and ready to call, but NOT wired to a caller: no
// score-entry feature exists yet anywhere in the app (out of scope for this
// pass — see Day 18 scoping). Once a score-submission API route exists,
// hooking this up is one line at the point a score is saved:
//   await labelGreenOnScoreSubmission({ foursomeId: registrationId, holeNumber, scoreSubmittedAt: new Date() });
export async function labelGreenOnScoreSubmission(params: {
  foursomeId: string; // registrations.id — the registration row is the foursome unit
  holeNumber: number;
  scoreSubmittedAt: Date;
}): Promise<LabelGreenResult> {
  const { foursomeId, holeNumber, scoreSubmittedAt } = params;
  const supabase = getSupabase();

  const windowStart = new Date(scoreSubmittedAt.getTime() - MATCH_WINDOW_MS).toISOString();
  const windowEnd = new Date(scoreSubmittedAt.getTime() + MATCH_WINDOW_MS).toISOString();

  const { data: tracks } = await supabase
    .from('gps_tracks')
    .select('id, device_id, lat, lng, recorded_at, course_id')
    .eq('foursome_id', foursomeId)
    .eq('hole_number', holeNumber)
    .is('feature_type', null)
    .gte('recorded_at', windowStart)
    .lte('recorded_at', windowEnd)
    .order('recorded_at', { ascending: false });

  if (!tracks?.length) return { labeled: 0, green: null };

  // Closest-in-time ping per device — each phone in the foursome may have
  // one in-window ping, and averaging across teammates gives a steadier fix
  // than any single phone's GPS noise.
  type Track = { id: string; device_id: string; lat: number; lng: number; recorded_at: string; course_id: string | null };
  const closestByDevice = new Map<string, Track>();
  for (const t of tracks as Track[]) {
    const existing = closestByDevice.get(t.device_id);
    const dt = Math.abs(new Date(t.recorded_at).getTime() - scoreSubmittedAt.getTime());
    const existingDt = existing ? Math.abs(new Date(existing.recorded_at).getTime() - scoreSubmittedAt.getTime()) : Infinity;
    if (dt < existingDt) closestByDevice.set(t.device_id, t);
  }
  const matched = [...closestByDevice.values()];
  const points: LatLng[] = matched.map((m) => ({ lat: Number(m.lat), lng: Number(m.lng) }));
  const green = centroid(points);
  const confidence = Math.min(1, matched.length / FULL_FOURSOME);
  const now = new Date().toISOString();

  await supabase
    .from('gps_tracks')
    .update({ feature_type: 'green', feature_source: 'score_submission' })
    .in('id', matched.map((m) => m.id));

  const courseId = matched[0].course_id;
  if (courseId) {
    await supabase.from('course_gps_features').insert({
      course_id: courseId,
      hole_number: holeNumber,
      feature_type: 'green',
      lat: green.lat,
      lng: green.lng,
      confidence,
      sample_count: matched.length,
      derived_at: now,
    });

    const { data: hole } = await supabase
      .from('course_holes')
      .select('id, gps_status')
      .eq('course_id', courseId)
      .eq('hole_number', holeNumber)
      .single();

    if (hole) {
      const existingStatus = (hole.gps_status as Record<string, unknown>) ?? {};
      await supabase
        .from('course_holes')
        .update({
          gps_status: {
            ...existingStatus,
            green: {
              lat: green.lat,
              lng: green.lng,
              sample_count: matched.length,
              confidence,
              detected_at: now,
            },
          },
        })
        .eq('id', hole.id);
    }
  }

  return { labeled: matched.length, green };
}
