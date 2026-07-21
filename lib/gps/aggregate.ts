import { createClient } from '@supabase/supabase-js';
import type { LatLng } from './geo';
import { aggregateFeature, aggregateFairway, type FeatureSample } from './aggregateCore';
import { inferHazards, type RoundTrack } from './hazardCore';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Rounds-per-hole needed before hazard inference runs at all. The filing
// says hazard boundaries emerge "after 10-20 tournaments"; running the
// detector on two rounds would emit noise dressed as hazards, so it stays
// silent below this floor.
export const HAZARD_MIN_ROUNDS = 8;

export interface AggregationRunResult {
  coursesProcessed: number;
  holesAggregated: number;
  hazardsWritten: number;
}

// Day 19 aggregation pass: fold every course's per-event detections
// (course_gps_features rows written by cluster detection, green labeling,
// and manual marks — across ALL tournaments at that course) into canonical
// per-hole tee/green positions + fairway routes with cross-tournament
// confidence, synced into course_holes.gps_status. Hazard regions are
// recomputed from raw tracks when enough independent rounds exist.
//
// Runs from the daily GPS cron after cluster detection. Idempotent: derived
// aggregates are recomputed from source data every run; hazard rows are
// replaced, never accumulated.
export async function aggregateCourseProfiles(): Promise<AggregationRunResult> {
  const supabase = getSupabase();
  const result: AggregationRunResult = { coursesProcessed: 0, holesAggregated: 0, hazardsWritten: 0 };

  // Every course with at least one detection event.
  const { data: features } = await supabase
    .from('course_gps_features')
    .select('course_id, hole_number, feature_type, lat, lng, confidence, sample_count, tournament_id')
    .in('feature_type', ['tee_box', 'green']);
  if (!features?.length) return result;

  const byCourse = new Map<string, typeof features>();
  for (const f of features) {
    if (!byCourse.has(f.course_id)) byCourse.set(f.course_id, []);
    byCourse.get(f.course_id)!.push(f);
  }

  for (const [courseId, courseFeatures] of byCourse) {
    result.coursesProcessed += 1;

    const { data: holes } = await supabase
      .from('course_holes')
      .select('id, hole_number, gps_status')
      .eq('course_id', courseId);
    const holeRows = new Map((holes ?? []).map((h) => [h.hole_number, h]));

    // Group events per hole per feature type.
    const grouped = new Map<string, FeatureSample[]>();
    for (const f of courseFeatures) {
      const k = `${f.hole_number}:${f.feature_type}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push({
        lat: Number(f.lat),
        lng: Number(f.lng),
        sampleCount: f.sample_count ?? 1,
        eventConfidence: Number(f.confidence ?? 0.5),
        tournamentId: f.tournament_id,
      });
    }

    // Aggregate tee/green per hole; remember them for fairway/hazard passes.
    const aggregated = new Map<number, { tee?: LatLng; green?: LatLng }>();
    for (const [k, samples] of grouped) {
      const [holeStr, featureType] = k.split(':');
      const holeNumber = Number(holeStr);
      const agg = aggregateFeature(samples);
      if (!agg) continue;

      const slot = featureType === 'tee_box' ? 'tee' : 'green';
      const entry = aggregated.get(holeNumber) ?? {};
      entry[slot as 'tee' | 'green'] = { lat: agg.lat, lng: agg.lng };
      aggregated.set(holeNumber, entry);

      const holeRow = holeRows.get(holeNumber);
      if (holeRow) {
        const existing = (holeRow.gps_status as Record<string, unknown>) ?? {};
        await supabase
          .from('course_holes')
          .update({
            gps_status: {
              ...existing,
              [slot]: {
                lat: agg.lat,
                lng: agg.lng,
                confidence: agg.confidence,
                sample_count: agg.contributingSamples,
                tournaments: agg.independentTournaments,
                spread_m: agg.spreadMeters,
                source: 'aggregate',
                aggregated_at: new Date().toISOString(),
              },
            },
          })
          .eq('id', holeRow.id);
        result.holesAggregated += 1;
        // keep the local copy fresh for the second slot of the same hole
        (holeRow.gps_status as Record<string, unknown>) = {
          ...existing,
          [slot]: { lat: agg.lat, lng: agg.lng },
        };
      }
    }

    // Fairway + hazards need raw per-round tracks for holes with both ends known.
    for (const [holeNumber, ends] of aggregated) {
      if (!ends.tee || !ends.green) continue;

      const { data: tracks } = await supabase
        .from('gps_tracks')
        .select('device_id, tournament_id, lat, lng, recorded_at')
        .eq('course_id', courseId)
        .eq('hole_number', holeNumber)
        .order('recorded_at', { ascending: true })
        .limit(20000);
      if (!tracks?.length) continue;

      const roundMap = new Map<string, RoundTrack>();
      for (const t of tracks) {
        const roundId = `${t.device_id}:${t.tournament_id ?? 'unknown'}`;
        if (!roundMap.has(roundId)) {
          roundMap.set(roundId, { roundId, tournamentId: t.tournament_id ?? 'unknown', points: [] });
        }
        roundMap.get(roundId)!.points.push({ lat: Number(t.lat), lng: Number(t.lng) });
      }
      const rounds = [...roundMap.values()];

      // Fairway route → gps_status.fairway (the third placeholder slot).
      const fairway = aggregateFairway(ends.tee, ends.green, rounds);
      const holeRow = holeRows.get(holeNumber);
      if (fairway && holeRow) {
        const existing = (holeRow.gps_status as Record<string, unknown>) ?? {};
        await supabase
          .from('course_holes')
          .update({
            gps_status: {
              ...existing,
              fairway: {
                waypoints: fairway.waypoints,
                confidence: fairway.confidence,
                rounds: fairway.contributingRounds,
                tournaments: fairway.independentTournaments,
                source: 'aggregate',
                aggregated_at: new Date().toISOString(),
              },
            },
          })
          .eq('id', holeRow.id);
      }

      // Hazards: only with enough independent rounds; replace, don't accumulate.
      if (rounds.length >= HAZARD_MIN_ROUNDS) {
        const hazards = inferHazards(ends.tee, ends.green, rounds);
        await supabase
          .from('course_gps_features')
          .delete()
          .eq('course_id', courseId)
          .eq('hole_number', holeNumber)
          .eq('feature_type', 'hazard');
        for (const hz of hazards) {
          await supabase.from('course_gps_features').insert({
            course_id: courseId,
            hole_number: holeNumber,
            tournament_id: null, // cross-tournament derivation
            feature_type: 'hazard',
            lat: hz.center.lat,
            lng: hz.center.lng,
            confidence: hz.confidence,
            sample_count: hz.avoidingRounds,
            derived_at: new Date().toISOString(),
          });
          result.hazardsWritten += 1;
        }
      }
    }
  }

  return result;
}
