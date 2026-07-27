import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { centroidOf, countWithinRadius, isValidRadius, type Member } from '@/lib/tourneycircle';

const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Module 7 — the opt-in prompt at score-submission completion. Identity is the
// player's own registration (they're on their round link; no login). Writes to
// the private store; the response carries only an aggregate count, never names.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const registrationId = typeof body?.registrationId === 'string' ? body.registrationId : '';
  if (!registrationId) return NextResponse.json({ error: 'registrationId required' }, { status: 400 });

  const service = getServiceSupabase();
  const { data: reg } = await service
    .from('registrations')
    .select('player_profile_id, contact_name, contact_email, tournament_id, registration_type')
    .eq('id', registrationId).maybeSingle();
  if (!reg) return NextResponse.json({ error: 'Unknown registration' }, { status: 404 });
  const profileId = reg.player_profile_id as string | null;
  if (!profileId) return NextResponse.json({ error: 'No player profile linked to this registration' }, { status: 409 });

  // Decline: record it so we never prompt this player again.
  if (body?.decline === true) {
    const { error } = await service.from('tourneycircle_declines').upsert({ player_profile_id: profileId }, { onConflict: 'player_profile_id' });
    if (error) return NextResponse.json({ error: 'TourneyCircle tables missing — run migration 032' }, { status: 500 });
    return NextResponse.json({ ok: true, declined: true });
  }

  const radius = Number(body?.radiusMiles ?? 25);
  const radiusMiles = isValidRadius(radius) ? radius : 25;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const homeLat = num(body?.homeLat);
  const homeLng = num(body?.homeLng);
  const cadence = Number(body?.cadenceDays);
  const cadenceDays = Number.isFinite(cadence) && cadence >= 5 && cadence <= 21 ? Math.round(cadence) : 10;
  const causes = Array.isArray(body?.causes) ? body.causes.filter((c: unknown) => typeof c === 'string').slice(0, 10) : [];
  const memberType = reg.registration_type === 'sponsor' ? 'corporate' : 'individual';

  const { error } = await service.from('tourneycircle_members').upsert({
    player_profile_id: profileId,
    email: reg.contact_email ?? null,
    name: reg.contact_name ?? null,
    home_lat: homeLat, home_lng: homeLng,
    radius_miles: radiusMiles,
    cause_preferences: causes,
    cadence_days: cadenceDays,
    member_type: memberType,
    source_tournament_id: reg.tournament_id ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'player_profile_id' });
  if (error) return NextResponse.json({ error: 'TourneyCircle tables missing — run migration 032' }, { status: 500 });

  // Aggregate-only confirmation: how many members are near this player.
  let nearby = 0;
  if (homeLat != null && homeLng != null) {
    const { data: members } = await service.from('tourneycircle_members').select('home_lat, home_lng, member_type');
    nearby = countWithinRadius((members ?? []) as Member[], centroidOf([{ lat: homeLat, lng: homeLng }]), radiusMiles).total;
  }
  return NextResponse.json({ ok: true, memberCountNearby: nearby });
}
