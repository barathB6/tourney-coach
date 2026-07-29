import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { centroidOf, countWithinRadius, disclose, isValidRadius, type DisclosedCount, type Member } from '@/lib/tourneycircle';

const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// GET ?reg=<registrationId> — the player's own TourneyCircle preferences, for
// the participant preferences dashboard. Identity is the registration link.
export async function GET(req: NextRequest) {
  const reg = new URL(req.url).searchParams.get('reg') ?? '';
  if (!reg) return NextResponse.json({ error: 'reg required' }, { status: 400 });
  const service = getServiceSupabase();
  const { data: r } = await service.from('registrations').select('player_profile_id, contact_name').eq('id', reg).maybeSingle();
  if (!r) return NextResponse.json({ error: 'Unknown registration' }, { status: 404 });
  if (!r.player_profile_id) return NextResponse.json({ name: r.contact_name, optedIn: false, declined: false, radiusMiles: 25, causes: [], cadenceDays: 10 });
  const { data: m } = await service.from('tourneycircle_members').select('radius_miles, cause_preferences, cadence_days').eq('player_profile_id', r.player_profile_id).maybeSingle();
  const { data: d } = await service.from('tourneycircle_declines').select('id').eq('player_profile_id', r.player_profile_id).maybeSingle();
  return NextResponse.json({
    name: r.contact_name,
    optedIn: !!m,
    declined: !!d,
    radiusMiles: m?.radius_miles ?? 25,
    causes: m?.cause_preferences ?? [],
    cadenceDays: m?.cadence_days ?? 10,
  });
}

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

  const payload: Record<string, unknown> = {
    player_profile_id: profileId,
    email: reg.contact_email ?? null,
    name: reg.contact_name ?? null,
    radius_miles: radiusMiles,
    cause_preferences: causes,
    cadence_days: cadenceDays,
    member_type: memberType,
    source_tournament_id: reg.tournament_id ?? null,
    updated_at: new Date().toISOString(),
  };
  // Only touch location when a fresh fix is provided — a preferences edit (no
  // geolocation) must never wipe the home location captured at opt-in.
  if (homeLat != null && homeLng != null) { payload.home_lat = homeLat; payload.home_lng = homeLng; }
  const { error } = await service.from('tourneycircle_members').upsert(payload, { onConflict: 'player_profile_id' });
  if (error) return NextResponse.json({ error: 'TourneyCircle tables missing — run migration 032' }, { status: 500 });

  // Aggregate-only confirmation: how many members are near this player.
  //
  // The reference point is the COURSE they just played, resolved server-side
  // from their registration — not any coordinate in this request, and not the
  // location this request just wrote.
  //
  // Anchoring it to the player's stored home was NOT enough, and the Phase E
  // integration test caught that: this same call writes that home location, so
  // anyone holding a registration id could move the anchor and read the count
  // back — sweeping a lat/lng grid to localize members, and corrupting the
  // victim's saved location on the way. Deriving the anchor from the
  // registration removes the caller's influence entirely. The count still
  // passes the disclosure threshold, so a sparse area reports nothing rather
  // than a number small enough to describe a person.
  let nearby: DisclosedCount = { value: 0, suppressed: true };
  const { data: tournament } = await service.from('tournaments')
    .select('course_id').eq('id', reg.tournament_id as string).maybeSingle();
  if (tournament?.course_id) {
    const { data: tracks } = await service.from('gps_tracks')
      .select('lat, lng').eq('course_id', tournament.course_id).limit(5000);
    const reference = centroidOf((tracks ?? []).map((t) => ({ lat: Number(t.lat), lng: Number(t.lng) })));
    if (reference) {
      const { data: members } = await service.from('tourneycircle_members').select('home_lat, home_lng, member_type');
      nearby = disclose(countWithinRadius((members ?? []) as Member[], reference, radiusMiles).total);
    }
  }
  return NextResponse.json({
    ok: true,
    memberCountNearby: nearby.suppressed ? null : nearby.value,
  });
}
