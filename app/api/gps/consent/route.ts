import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Records explicit, affirmative consent before any GPS collection starts.
// The device token is generated client-side (crypto.randomUUID()) and
// stored in the browser's localStorage — there's no player login to key an
// identity off (registrations has no user_id), so the token is what ties
// later /api/gps/track pings back to a consenting device.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const registrationId = body?.registrationId;
  const deviceToken = body?.deviceToken;
  const playerName = typeof body?.playerName === 'string' ? body.playerName.slice(0, 200) : null;

  if (typeof registrationId !== 'string' || typeof deviceToken !== 'string' || deviceToken.length < 10) {
    return NextResponse.json({ error: 'Missing registrationId or deviceToken' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: reg } = await supabase.from('registrations').select('id').eq('id', registrationId).single();
  if (!reg) return NextResponse.json({ error: 'Registration not found' }, { status: 404 });

  let { data: device } = await supabase
    .from('gps_devices')
    .select('id')
    .eq('device_token', deviceToken)
    .maybeSingle();

  if (!device) {
    const { data: inserted, error: insertErr } = await supabase
      .from('gps_devices')
      .insert({ registration_id: registrationId, device_token: deviceToken, player_name: playerName })
      .select('id')
      .single();
    if (insertErr || !inserted) {
      return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
    }
    device = inserted;
  }

  const { error: consentErr } = await supabase
    .from('gps_consent_events')
    .insert({ device_id: device.id, event: 'granted' });

  if (consentErr) {
    return NextResponse.json({ error: 'Failed to record consent' }, { status: 500 });
  }

  return NextResponse.json({ deviceId: device.id });
}
