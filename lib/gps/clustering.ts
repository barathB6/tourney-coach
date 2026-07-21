import { createClient } from '@supabase/supabase-js';
import { centroid, spreadMeters, type LatLng } from './geo';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MIN_DEVICES = 2;
const FULL_FOURSOME = 4; // confidence hits 1.0 when all four players' phones agree
const MAX_SPREAD_M = 30; // phones within ~30m of each other reads as "the same tee box"
// The cron runs once a day (0 6 * * *), so the lookback must span a full day
// of play plus margin — a 6h window at 6am would only ever see pre-dawn
// tracks and never catch a tournament. Re-scanning is safe: detected pings are
// tagged (feature_type set) and a (hole, tournament) already recorded is
// skipped, so a wide window never double-counts.
const LOOKBACK_HOURS = 30;

export interface ClusterResult {
  holeId: string;
  courseId: string;
  holeNumber: number;
  deviceCount: number;
  spreadMeters: number;
  confidence: number;
  centroid: LatLng;
}

type Track = { id: string; device_id: string; foursome_id: string; tournament_id: string | null; lat: number; lng: number; recorded_at: string };

// Patent mechanism, tee-box half: "when 4 players cluster at the same spot
// before a hole → tag as tee_box for that hole." For each foursome, each
// device's *first* untagged ping on a hole is a proxy for standing at the
// tee — the moment before the group fans out down the fairway. If a
// foursome's first-pings converge within MAX_SPREAD_M, the centroid becomes
// a tee_box row in course_gps_features (confidence = devices/4) and syncs
// into course_holes.gps_status.tee, the Day 17 placeholder. Meant to run
// periodically (app/api/cron/gps-clusters/route.ts).
//
// Cross-tournament accrual (the confidence model depends on it): each
// tournament that fields a converging group on a hole contributes its OWN
// tee_box detection. A (hole, tournament) that already has one is skipped, so
// re-runs never double-count — but a NEW tournament always gets recorded, and
// the daily aggregation pass folds all of them into a cross-tournament
// confidence. (The old code gated on "hole has no tee yet", which locked a
// hole to a single tournament forever and capped confidence at ~0.36.)
export async function detectTeeClusters(): Promise<ClusterResult[]> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  const { data: holes } = await supabase
    .from('course_holes')
    .select('id, course_id, hole_number, gps_status');
  if (!holes?.length) return [];

  // Which (course, hole, tournament) tee boxes are already recorded — one
  // detection per tournament per hole is the independence unit.
  const { data: existingTees } = await supabase
    .from('course_gps_features')
    .select('course_id, hole_number, tournament_id')
    .eq('feature_type', 'tee_box');
  const detected = new Set(
    (existingTees ?? []).map((t) => `${t.course_id}:${t.hole_number}:${t.tournament_id ?? 'unknown'}`),
  );

  const results: ClusterResult[] = [];

  for (const hole of holes) {
    const { data: tracks } = await supabase
      .from('gps_tracks')
      .select('id, device_id, foursome_id, tournament_id, lat, lng, recorded_at')
      .eq('course_id', hole.course_id)
      .eq('hole_number', hole.hole_number)
      .is('feature_type', null)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: true });

    const rows = (tracks ?? []) as Track[];
    if (!rows.length) continue;

    // First untagged ping per device, grouped by foursome — the cluster
    // claim is about one group's phones converging, not strangers who
    // happen to share a hole across the day.
    const byFoursome = new Map<string, Map<string, Track>>();
    for (const t of rows) {
      const devices = byFoursome.get(t.foursome_id) ?? new Map<string, Track>();
      if (!devices.has(t.device_id)) devices.set(t.device_id, t);
      byFoursome.set(t.foursome_id, devices);
    }

    // Best converging foursome PER TOURNAMENT (not one global best), skipping
    // tournaments already recorded for this hole. Many foursomes from the same
    // tournament collapse to that tournament's single best cluster.
    const bestByTournament = new Map<string, { pings: Track[]; spread: number; tournamentId: string | null }>();
    for (const devices of byFoursome.values()) {
      if (devices.size < MIN_DEVICES) continue;
      const pings = [...devices.values()];
      const spread = spreadMeters(pings.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })));
      if (spread > MAX_SPREAD_M) continue;
      const tournamentId = pings[0].tournament_id ?? null;
      const tKey = tournamentId ?? 'unknown';
      if (detected.has(`${hole.course_id}:${hole.hole_number}:${tKey}`)) continue;
      const cur = bestByTournament.get(tKey);
      if (!cur || pings.length > cur.pings.length) bestByTournament.set(tKey, { pings, spread, tournamentId });
    }
    if (!bestByTournament.size) continue;

    const now = new Date().toISOString();
    let strongest: { center: LatLng; count: number; spread: number } | null = null;

    for (const best of bestByTournament.values()) {
      const points: LatLng[] = best.pings.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
      const center = centroid(points);
      const confidence = Math.min(1, best.pings.length / FULL_FOURSOME);

      await supabase.from('course_gps_features').insert({
        course_id: hole.course_id,
        hole_number: hole.hole_number,
        tournament_id: best.tournamentId,
        feature_type: 'tee_box',
        lat: center.lat,
        lng: center.lng,
        confidence,
        sample_count: best.pings.length,
        derived_at: now,
      });
      detected.add(`${hole.course_id}:${hole.hole_number}:${best.tournamentId ?? 'unknown'}`);

      await supabase
        .from('gps_tracks')
        .update({ feature_type: 'tee_box', feature_source: 'cluster_detection' })
        .in('id', best.pings.map((p) => p.id));

      if (!strongest || best.pings.length > strongest.count) {
        strongest = { center, count: best.pings.length, spread: best.spread };
      }

      results.push({
        holeId: hole.id,
        courseId: hole.course_id,
        holeNumber: hole.hole_number,
        deviceCount: best.pings.length,
        spreadMeters: best.spread,
        confidence,
        centroid: center,
      });
    }

    // Provisional gps_status.tee for immediate UI feedback, but ONLY if unset —
    // once the daily aggregation pass has written the canonical cross-tournament
    // tee we must not fight it (it carries the real confidence/tournament count).
    const existingStatus = (hole.gps_status as Record<string, unknown>) ?? {};
    if (strongest && !existingStatus.tee) {
      await supabase
        .from('course_holes')
        .update({
          gps_status: {
            ...existingStatus,
            tee: {
              lat: strongest.center.lat,
              lng: strongest.center.lng,
              sample_count: strongest.count,
              confidence: Math.min(1, strongest.count / FULL_FOURSOME),
              spread_m: Math.round(strongest.spread),
              detected_at: now,
              source: 'cluster_detection',
            },
          },
        })
        .eq('id', hole.id);
    }
  }

  return results;
}
