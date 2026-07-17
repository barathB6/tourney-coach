import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { activeConsentDeviceIds as computeActiveConsentDeviceIds } from '@/lib/gps/consent';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Real counts from real queries only — no fabricated "live" operational
// numbers. A brand-new pipeline showing near-zero activity is the honest
// state and is shown as such, not padded to look impressive.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const supabase = getSupabase();
  const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.slice(7));
  if (authErr || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

  const [
    { count: totalTracks },
    { count: totalDevices },
    { count: tracksLast24h },
    { data: lastTrack },
    activeDeviceIds,
    { data: holes },
    { data: features },
  ] = await Promise.all([
    supabase.from('gps_tracks').select('*', { count: 'exact', head: true }),
    supabase.from('gps_devices').select('*', { count: 'exact', head: true }),
    supabase.from('gps_tracks').select('*', { count: 'exact', head: true }).gte('received_at', since24h),
    supabase.from('gps_tracks').select('received_at').order('received_at', { ascending: false }).limit(1).maybeSingle(),
    computeActiveConsentDeviceIds(supabase),
    supabase.from('course_holes').select('course_id, hole_number, gps_status, courses(name, total_holes)'),
    supabase.from('course_gps_features').select('feature_type'),
  ]);

  let registrationsWithConsent = 0;
  if (activeDeviceIds.length) {
    const { data: devices } = await supabase.from('gps_devices').select('registration_id').in('id', activeDeviceIds);
    registrationsWithConsent = new Set((devices ?? []).map((d) => d.registration_id)).size;
  }

  const holeRows = holes ?? [];
  const teeDetected = holeRows.filter((h) => (h.gps_status as Record<string, unknown> | null)?.tee).length;
  const greenDetected = holeRows.filter((h) => (h.gps_status as Record<string, unknown> | null)?.green).length;

  const featuresByType: Record<string, number> = {};
  for (const f of features ?? []) {
    featuresByType[f.feature_type] = (featuresByType[f.feature_type] ?? 0) + 1;
  }

  const byCourseMap = new Map<string, { name: string; totalHoles: number; teeDetected: number; greenDetected: number }>();
  for (const h of holeRows) {
    const course = h.courses as unknown as { name: string; total_holes: number } | null;
    if (!course) continue;
    const entry = byCourseMap.get(h.course_id) ?? { name: course.name, totalHoles: course.total_holes, teeDetected: 0, greenDetected: 0 };
    const status = h.gps_status as Record<string, unknown> | null;
    if (status?.tee) entry.teeDetected += 1;
    if (status?.green) entry.greenDetected += 1;
    byCourseMap.set(h.course_id, entry);
  }

  return NextResponse.json({
    totalTracks: totalTracks ?? 0,
    totalDevices: totalDevices ?? 0,
    activeConsentDevices: activeDeviceIds.length,
    registrationsWithConsent,
    tracksLast24h: tracksLast24h ?? 0,
    lastIngestAt: lastTrack?.received_at ?? null,
    holesWithTeeDetected: teeDetected,
    holesWithGreenDetected: greenDetected,
    totalHolesTracked: holeRows.length,
    derivedFeaturesByType: featuresByType,
    byCourse: [...byCourseMap.values()],
  });
}
