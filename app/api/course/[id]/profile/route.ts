import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// The Day 19 hybrid course profile: pro-entered structured data (par,
// yardage, handicap — from the Course Builder) fused with GPS-derived
// spatial data (aggregated tee/green positions, fairway route, inferred
// hazards, each carrying its cross-tournament confidence). Public read,
// same as the live-round context route — this is what player-facing maps
// consume. Every number is real aggregation output; holes with no GPS data
// simply have null gps fields.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabase();

  const [{ data: course }, { data: holes }, { data: hazards }] = await Promise.all([
    supabase.from('courses').select('id, name, city, state, total_holes, par_total, tees').eq('id', id).maybeSingle(),
    supabase.from('course_holes').select('hole_number, par, handicap, description, tee_yardages, gps_status').eq('course_id', id).order('hole_number'),
    supabase.from('course_gps_features').select('hole_number, lat, lng, confidence, sample_count, derived_at').eq('course_id', id).eq('feature_type', 'hazard'),
  ]);

  if (!course) return NextResponse.json({ error: 'Course not found' }, { status: 404 });

  const hazardsByHole = new Map<number, NonNullable<typeof hazards>>();
  for (const hz of hazards ?? []) {
    if (!hazardsByHole.has(hz.hole_number)) hazardsByHole.set(hz.hole_number, []);
    hazardsByHole.get(hz.hole_number)!.push(hz);
  }

  const profile = (holes ?? []).map((h) => {
    const gps = (h.gps_status as Record<string, unknown> | null) ?? {};
    return {
      holeNumber: h.hole_number,
      // pro-entered (Course Builder)
      proEntered: {
        par: h.par,
        handicap: h.handicap,
        description: h.description,
        teeYardages: h.tee_yardages,
      },
      // GPS-derived (aggregation pipeline), null until real data exists
      gpsDerived: {
        tee: gps.tee ?? null,
        green: gps.green ?? null,
        fairway: gps.fairway ?? null,
        hazards: (hazardsByHole.get(h.hole_number) ?? []).map((hz) => ({
          lat: Number(hz.lat),
          lng: Number(hz.lng),
          confidence: Number(hz.confidence ?? 0),
          avoidingRounds: hz.sample_count,
          derivedAt: hz.derived_at,
        })),
      },
    };
  });

  return NextResponse.json({
    course: {
      id: course.id,
      name: course.name,
      location: [course.city, course.state].filter(Boolean).join(', '),
      totalHoles: course.total_holes,
      parTotal: course.par_total,
      tees: course.tees,
    },
    holes: profile,
  });
}
