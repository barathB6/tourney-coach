import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// A player can withdraw consent at any time — this stops future /api/gps/track
// writes from that device immediately (the ingest route checks the same
// gps_active_consent view this appends to) without deleting the audit trail.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const deviceToken = body?.deviceToken;
  if (typeof deviceToken !== 'string') {
    return NextResponse.json({ error: 'Missing deviceToken' }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: device } = await supabase.from('gps_devices').select('id').eq('device_token', deviceToken).maybeSingle();
  if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

  const { error } = await supabase.from('gps_consent_events').insert({ device_id: device.id, event: 'revoked' });
  if (error) return NextResponse.json({ error: 'Failed to revoke' }, { status: 500 });

  return NextResponse.json({ ok: true });
}
