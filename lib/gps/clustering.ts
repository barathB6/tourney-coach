import { createClient } from '@supabase/supabase-js';
import { centroid, spreadMeters, type LatLng } from './geo';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MIN_DEVICES = 2;
const FULL_FOURSOME = 4; // confidence hits 1.0 when all four players' phones agree
const MAX_SPREAD_M = 30; // phones within ~30m of each other reads as "the same tee box"
const LOOKBACK_HOURS = 6;

export interface ClusterResult {
  holeId: string;
  courseId: string;
  holeNumber: number;
  deviceCount: number;
  spreadMeters: number;
  confidence: number;
  centroid: LatLng;
}

type Track = { id: string; device_id: string; foursome_id: string; lat: number; lng: number; recorded_at: string };

// Patent mechanism, tee-box half: "when 4 players cluster at the same spot
// before a hole → tag as tee_box for that hole." For each foursome, each
// device's *first* untagged ping on a hole is a proxy for standing at the
// tee — the moment before the group fans out down the fairway. If a
// foursome's first-pings converge within MAX_SPREAD_M, the centroid becomes
// a tee_box row in course_gps_features (confidence = devices/4) and syncs
// into course_holes.gps_status.tee, the Day 17 placeholder. Meant to run
// periodically (app/api/cron/gps-clusters/route.ts) — safe to repeat, since
// it only ever touches holes whose tee is still unset.
export async function detectTeeClusters(): Promise<ClusterResult[]> {
  const supabase = getSupabase();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  const { data: holes } = await supabase
    .from('course_holes')
    .select('id, course_id, hole_number, gps_status');

  const pending = (holes ?? []).filter((h) => {
    const status = h.gps_status as Record<string, unknown> | null;
    return !status?.tee;
  });
  if (!pending.length) return [];

  const results: ClusterResult[] = [];

  for (const hole of pending) {
    const { data: tracks } = await supabase
      .from('gps_tracks')
      .select('id, device_id, foursome_id, lat, lng, recorded_at')
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

    // Best candidate cluster = the foursome with the most converging devices.
    let best: { pings: Track[]; spread: number } | null = null;
    for (const devices of byFoursome.values()) {
      if (devices.size < MIN_DEVICES) continue;
      const pings = [...devices.values()];
      const spread = spreadMeters(pings.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })));
      if (spread > MAX_SPREAD_M) continue;
      if (!best || pings.length > best.pings.length) best = { pings, spread };
    }
    if (!best) continue;

    const points: LatLng[] = best.pings.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    const center = centroid(points);
    const confidence = Math.min(1, best.pings.length / FULL_FOURSOME);
    const now = new Date().toISOString();

    await supabase.from('course_gps_features').insert({
      course_id: hole.course_id,
      hole_number: hole.hole_number,
      feature_type: 'tee_box',
      lat: center.lat,
      lng: center.lng,
      confidence,
      sample_count: best.pings.length,
      derived_at: now,
    });

    const existingStatus = (hole.gps_status as Record<string, unknown>) ?? {};
    await supabase
      .from('course_holes')
      .update({
        gps_status: {
          ...existingStatus,
          tee: {
            lat: center.lat,
            lng: center.lng,
            sample_count: best.pings.length,
            confidence,
            spread_m: Math.round(best.spread),
            detected_at: now,
          },
        },
      })
      .eq('id', hole.id);

    await supabase
      .from('gps_tracks')
      .update({ feature_type: 'tee_box', feature_source: 'cluster_detection' })
      .in('id', best.pings.map((p) => p.id));

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

  return results;
}
