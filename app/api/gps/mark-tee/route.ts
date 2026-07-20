import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isDeviceConsented } from '@/lib/gps/consent';
import { markTeeBox } from '@/lib/gps/markTee';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Manual "mark tee box here": the player, standing on the tee, tags their
// current GPS position as this hole's tee. Consent-gated like the rest of
// the pipeline; the course is resolved from the consented device, never
// trusted from the request body.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { deviceToken, holeNumber, lat, lng } = body ?? {};

  if (typeof deviceToken !== 'string' || deviceToken.length < 10) {
    return NextResponse.json({ error: 'Missing deviceToken' }, { status: 400 });
  }
  if (typeof holeNumber !== 'number' || holeNumber < 1 || holeNumber > 18) {
    return NextResponse.json({ error: 'holeNumber must be 1-18' }, { status: 400 });
  }
  if (typeof lat !== 'number' || lat < -90 || lat > 90 || typeof lng !== 'number' || lng < -180 || lng > 180) {
    return NextResponse.json({ error: 'Valid lat/lng required' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: device } = await supabase
    .from('gps_devices')
    .select('id, registration_id, registrations(tournaments(course_id))')
    .eq('device_token', deviceToken)
    .maybeSingle();
  if (!device) {
    return NextResponse.json({ error: 'Unknown device — opt in first' }, { status: 403 });
  }
  if (!(await isDeviceConsented(supabase, device.id))) {
    return NextResponse.json({ error: 'Consent not active for this device' }, { status: 403 });
  }

  const reg = device.registrations as unknown as { tournaments: { course_id: string | null } | null } | null;
  const courseId = reg?.tournaments?.course_id;
  if (!courseId) {
    return NextResponse.json({ error: 'No course profile for this tournament' }, { status: 404 });
  }

  await markTeeBox({ courseId, holeNumber, lat, lng });
  return NextResponse.json({ marked: true, holeNumber });
}
