import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { activeConsentDeviceIds as computeActiveConsentDeviceIds } from '@/lib/gps/consent';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Coverage = 'verified' | 'building' | 'pending';

// A feature type is "verified" once every hole on the course has it, "building"
// while some do, "pending" when none do yet.
function coverageFrom(withFeature: number, totalHoles: number): Coverage {
  if (totalHoles > 0 && withFeature >= totalHoles) return 'verified';
  if (withFeature > 0) return 'building';
  return 'pending';
}

// Real counts from real queries only — no fabricated "live" operational
// numbers. A brand-new pipeline showing near-zero activity is the honest
// state and is shown as such, not padded to look impressive. This backs the
// internal pipeline dashboard, which is captioned as reflecting the
// provisional patent filing — so every figure here has to be defensible.
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
  const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();

  const [
    { count: totalTracks },
    { count: totalDevices },
    { count: tracksLast24h },
    { count: tracksPrev24h },
    { data: lastTrack },
    activeDeviceIds,
    { data: courses },
    { data: holes },
    { data: features },
    { data: tournaments },
    { data: greenTracks },
  ] = await Promise.all([
    supabase.from('gps_tracks').select('*', { count: 'exact', head: true }),
    supabase.from('gps_devices').select('*', { count: 'exact', head: true }),
    supabase.from('gps_tracks').select('*', { count: 'exact', head: true }).gte('received_at', since24h),
    supabase.from('gps_tracks').select('*', { count: 'exact', head: true }).gte('received_at', since48h).lt('received_at', since24h),
    supabase.from('gps_tracks').select('received_at').order('received_at', { ascending: false }).limit(1).maybeSingle(),
    computeActiveConsentDeviceIds(supabase),
    supabase.from('courses').select('id, name, city, state'),
    supabase.from('course_holes').select('course_id, gps_status'),
    supabase.from('course_gps_features').select('course_id, feature_type'),
    supabase.from('tournaments').select('course_id'),
    supabase.from('gps_tracks').select('accuracy').eq('feature_type', 'green').not('accuracy', 'is', null),
  ]);

  // Rounds currently tracking = distinct registrations (foursomes) with an
  // actively-granted device, plus the distinct courses those sit on.
  let activeRounds = 0;
  const activeCourseIds = new Set<string>();
  if (activeDeviceIds.length) {
    const { data: devices } = await supabase
      .from('gps_devices')
      .select('registration_id, registrations(tournament_id, tournaments(course_id))')
      .in('id', activeDeviceIds);
    activeRounds = new Set((devices ?? []).map((d) => d.registration_id)).size;
    for (const d of devices ?? []) {
      const reg = d.registrations as unknown as { tournaments?: { course_id?: string } } | null;
      if (reg?.tournaments?.course_id) activeCourseIds.add(reg.tournaments.course_id);
    }
  }

  // Per-course hole tallies from the gps_status placeholder synced by the
  // cluster/green mechanisms.
  const holeStats = new Map<string, { total: number; tee: number; green: number }>();
  for (const h of holes ?? []) {
    const s = (h.gps_status as Record<string, unknown> | null) ?? {};
    const e = holeStats.get(h.course_id) ?? { total: 0, tee: 0, green: 0 };
    e.total += 1;
    if (s.tee) e.tee += 1;
    if (s.green) e.green += 1;
    holeStats.set(h.course_id, e);
  }

  // Fairway/hazard live in course_gps_features (distinct holes carrying each type).
  const featureHoles = new Map<string, { fairway: number; hazard: number }>();
  for (const f of features ?? []) {
    const e = featureHoles.get(f.course_id) ?? { fairway: 0, hazard: 0 };
    if (f.feature_type === 'fairway') e.fairway += 1;
    if (f.feature_type === 'hazard') e.hazard += 1;
    featureHoles.set(f.course_id, e);
  }

  const tournamentsByCourse = new Map<string, number>();
  for (const t of tournaments ?? []) {
    if (!t.course_id) continue;
    tournamentsByCourse.set(t.course_id, (tournamentsByCourse.get(t.course_id) ?? 0) + 1);
  }

  // Only surface courses actually in play: those hosting a tournament or
  // carrying a hole profile. Empty seed courses stay off the board.
  const perCourse = (courses ?? [])
    .filter((c) => tournamentsByCourse.has(c.id) || holeStats.has(c.id))
    .map((c) => {
      const hs = holeStats.get(c.id) ?? { total: 0, tee: 0, green: 0 };
      const fh = featureHoles.get(c.id) ?? { fairway: 0, hazard: 0 };
      const totalHoles = hs.total || 18;
      // Tee/green pair is verified only when the course has BOTH for every hole.
      const teeGreen: Coverage =
        hs.tee >= totalHoles && hs.green >= totalHoles ? 'verified'
        : hs.tee > 0 || hs.green > 0 ? 'building'
        : 'pending';
      return {
        name: c.name,
        location: [c.city, c.state].filter(Boolean).join(', '),
        tournaments: tournamentsByCourse.get(c.id) ?? 0,
        teeGreen,
        fairway: coverageFrom(fh.fairway, totalHoles),
        hazard: coverageFrom(fh.hazard, totalHoles),
      };
    })
    .sort((a, b) => b.tournaments - a.tournaments);

  const verifiedCourses = perCourse.filter((c) => c.teeGreen === 'verified').length;

  // Average GPS accuracy (metres) reported by phones for green-tagged points —
  // null until any greens are mapped, never a placeholder figure.
  const accuracies = (greenTracks ?? []).map((t) => Number(t.accuracy)).filter((n) => !Number.isNaN(n));
  const avgGreenAccuracyM = accuracies.length
    ? Math.round((accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 10) / 10
    : null;

  return NextResponse.json({
    activeRounds,
    activeCourses: activeCourseIds.size,
    coordsToday: tracksLast24h ?? 0,
    coordsYesterday: tracksPrev24h ?? 0,
    totalTracks: totalTracks ?? 0,
    totalDevices: totalDevices ?? 0,
    activeConsentDevices: activeDeviceIds.length,
    verifiedCourses,
    avgGreenAccuracyM,
    lastIngestAt: lastTrack?.received_at ?? null,
    perCourse,
  });
}
