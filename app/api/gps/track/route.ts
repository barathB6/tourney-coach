import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isDeviceConsented } from '@/lib/gps/consent';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MAX_POINTS_PER_REQUEST = 60; // 15 minutes of pings at the 15s logging interval, plenty for one offline-cache flush

interface RawPoint {
  lat: number;
  lng: number;
  accuracy?: number;
  recordedAt: string;
}

function isValidPoint(p: unknown): p is RawPoint {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.lat === 'number' && o.lat >= -90 && o.lat <= 90 &&
    typeof o.lng === 'number' && o.lng >= -180 && o.lng <= 180 &&
    typeof o.recordedAt === 'string' && !Number.isNaN(Date.parse(o.recordedAt))
  );
}

// Batch ingestion for passive GPS collection. The live-round page caches
// pings locally (in-memory + localStorage) whenever the phone is offline or
// a request fails, then flushes the queue here — so this always accepts an
// array, not a single point.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { deviceToken, tournamentId, courseId, holeNumber, points } = body ?? {};

  if (typeof deviceToken !== 'string' || typeof tournamentId !== 'string' || typeof courseId !== 'string') {
    return NextResponse.json({ error: 'Missing deviceToken, tournamentId, or courseId' }, { status: 400 });
  }
  if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
    return NextResponse.json({ error: 'holeNumber must be 1-18' }, { status: 400 });
  }
  if (!Array.isArray(points) || points.length === 0) {
    return NextResponse.json({ error: 'points must be a non-empty array' }, { status: 400 });
  }

  const validPoints = points.filter(isValidPoint).slice(0, MAX_POINTS_PER_REQUEST);
  if (!validPoints.length) {
    return NextResponse.json({ error: 'No valid points in batch' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: device } = await supabase.from('gps_devices').select('id, registration_id').eq('device_token', deviceToken).maybeSingle();
  if (!device) return NextResponse.json({ error: 'Unknown device — consent required first' }, { status: 403 });

  if (!(await isDeviceConsented(supabase, device.id))) {
    return NextResponse.json({ error: 'Consent not active for this device' }, { status: 403 });
  }

  // foursome_id = the device's registration: the registration row is the
  // foursome unit in this schema, and it comes from the consented device
  // record — never from the request body, which a client could spoof.
  const rows = validPoints.map((p) => ({
    device_id: device.id,
    foursome_id: device.registration_id,
    tournament_id: tournamentId,
    course_id: courseId,
    hole_number: holeNumber,
    lat: p.lat,
    lng: p.lng,
    accuracy: typeof p.accuracy === 'number' ? Math.min(9999.99, p.accuracy) : null,
    recorded_at: p.recordedAt,
  }));

  const { error } = await supabase.from('gps_tracks').insert(rows);
  if (error) return NextResponse.json({ error: 'Failed to store points' }, { status: 500 });

  return NextResponse.json({ inserted: rows.length });
}
