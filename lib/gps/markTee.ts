import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Manual tee-box mark: a single player explicitly tags their current GPS
// position as the tee for a hole. Complements the automatic 4-player
// convergence detection in clustering.ts — same destination
// (course_gps_features + course_holes.gps_status.tee), lower confidence
// since it's one point from one phone rather than a converged cluster.
// An explicit manual mark overwrites whatever was there: the player is
// standing on the tee and saying so.
export async function markTeeBox(params: {
  courseId: string;
  holeNumber: number;
  lat: number;
  lng: number;
}): Promise<void> {
  const { courseId, holeNumber, lat, lng } = params;
  const supabase = getSupabase();
  const now = new Date().toISOString();

  await supabase.from('course_gps_features').insert({
    course_id: courseId,
    hole_number: holeNumber,
    feature_type: 'tee_box',
    lat,
    lng,
    confidence: 0.5, // single manual sample; cluster detection reaches 1.0
    sample_count: 1,
    derived_at: now,
  });

  const { data: hole } = await supabase
    .from('course_holes')
    .select('id, gps_status')
    .eq('course_id', courseId)
    .eq('hole_number', holeNumber)
    .maybeSingle();

  if (hole) {
    const existing = (hole.gps_status as Record<string, unknown>) ?? {};
    await supabase
      .from('course_holes')
      .update({
        gps_status: {
          ...existing,
          tee: { lat, lng, source: 'manual', sample_count: 1, confidence: 0.5, detected_at: now },
        },
      })
      .eq('id', hole.id);
  }
}
