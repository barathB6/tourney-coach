import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isDeviceConsented } from '@/lib/gps/consent';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Public (no login — players don't have accounts): everything the /live/[id]
// consent + tracking page needs to render, keyed off the registration id in
// the link a player opens on their phone. If a device token is passed, also
// reports whether that device currently has active consent so the page can
// skip straight to the tracking view on a returning visit.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deviceToken = req.nextUrl.searchParams.get('device');
  const supabase = getSupabase();

  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('id, contact_name, starting_hole, tournament_id, tournaments(id, name, course_id, selected_tees)')
    .eq('id', id)
    .single();

  if (regErr || !reg) {
    return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
  }

  const tournament = reg.tournaments as unknown as { id: string; name: string; course_id: string | null; selected_tees: string[] | null } | null;
  if (!tournament?.course_id) {
    return NextResponse.json({ error: 'This tournament has no course set up yet' }, { status: 404 });
  }

  const [{ data: course }, { data: holes }] = await Promise.all([
    supabase.from('courses').select('id, name, total_holes, tees').eq('id', tournament.course_id).single(),
    supabase.from('course_holes').select('hole_number, par, description, tee_yardages, gps_status').eq('course_id', tournament.course_id).order('hole_number'),
  ]);

  let hasConsent: boolean | null = null;
  if (deviceToken) {
    const { data: device } = await supabase
      .from('gps_devices')
      .select('id')
      .eq('device_token', deviceToken)
      .eq('registration_id', id)
      .maybeSingle();
    if (device) {
      hasConsent = await isDeviceConsented(supabase, device.id);
    } else {
      hasConsent = false;
    }
  }

  return NextResponse.json({
    registration: { id: reg.id, contactName: reg.contact_name, startingHole: reg.starting_hole },
    tournament: { id: tournament.id, name: tournament.name, courseId: tournament.course_id, selectedTees: tournament.selected_tees },
    course: course ? { id: course.id, name: course.name, totalHoles: course.total_holes, tees: course.tees } : null,
    holes: holes ?? [],
    hasConsent,
  });
}
