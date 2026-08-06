import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { centroidOf, countWithinRadius, discloseLadder, isValidRadius, RADIUS_OPTIONS, type DisclosedCount, type Member } from '@/lib/tourneycircle';
import { sendCircleWelcomeEmail } from '@/lib/email/circleWelcome';
import { getPublicAppUrl } from '@/lib/publicUrl';

const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// ── Who is allowed to read a member row ─────────────────────────────────────
//
// Not the registration id. That id is the round-link credential — it opens the
// live scorecard, and the organizer legitimately holds one for every player at
// their event (app/dashboard/registrations lists them). Using it here meant an
// organizer could curl one and read back a NAMED player's TourneyCircle
// membership, radius and cause preferences, then repeat it down the roster to
// rebuild the private member list. That is exactly the per-individual
// disclosure MIN_DISCLOSABLE_COUNT exists to prevent, and no threshold applied
// on that path at all.
//
// prefs_token (migration 046) is the player's own secret. It reaches them by
// email at opt-in and nowhere else — never in a response keyed by anything the
// organizer can see.
const PREFS_MISSING = 'This preferences link is no longer valid. Open the newest one from your TourneyCircle email.';
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const prefsUrlFor = (token: string) => `${getPublicAppUrl()}/circle/preferences?token=${token}`;

// GET ?token=<prefs_token> — the player's own preferences.
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!TOKEN_RE.test(token)) return NextResponse.json({ error: PREFS_MISSING }, { status: 404 });

  const service = getServiceSupabase();
  const { data: m } = await service.from('tourneycircle_members')
    .select('player_profile_id, name, radius_miles, cause_preferences, cadence_days')
    .eq('prefs_token', token).maybeSingle();
  if (!m) return NextResponse.json({ error: PREFS_MISSING }, { status: 404 });

  return NextResponse.json({
    name: m.name ?? null,
    optedIn: true,
    radiusMiles: m.radius_miles ?? 25,
    causes: m.cause_preferences ?? [],
    cadenceDays: m.cadence_days ?? 10,
  });
}

// The aggregate confirmation shown after opt-in: how many members are near the
// course this player just played.
//
// The reference point is the COURSE, resolved server-side from the
// registration — not any coordinate in the request, and not the location this
// request may have just written. Anchoring it to the player's stored home was
// NOT enough (the Phase E test caught that: the same call writes that home, so
// anyone holding the id could move the anchor and sweep a grid). The caller is
// excluded from their own count for the same reason.
//
// The number goes through the LADDER, not the standalone floor. radiusMiles is
// caller-supplied and the radii are concentric, so four probes at 15/25/35/50
// against a fixed anchor produce nested totals whose differences are rings —
// 6 then 7 both clear the floor of 5 and still reveal exactly one person. This
// is the same reasoning that already governs the organizer's circle route.
async function nearbyCount(
  service: ReturnType<typeof getServiceSupabase>,
  tournamentId: string | null,
  excludeProfileId: string | null,
  radiusMiles: number,
): Promise<DisclosedCount> {
  if (!tournamentId) return { value: 0, suppressed: true };
  const { data: tournament } = await service.from('tournaments')
    .select('course_id').eq('id', tournamentId).maybeSingle();
  if (!tournament?.course_id) return { value: 0, suppressed: true };

  const { data: tracks } = await service.from('gps_tracks')
    .select('lat, lng').eq('course_id', tournament.course_id).limit(5000);
  const reference = centroidOf((tracks ?? []).map((t) => ({ lat: Number(t.lat), lng: Number(t.lng) })));
  if (!reference) return { value: 0, suppressed: true };

  const { data: members } = await service.from('tourneycircle_members')
    .select('player_profile_id, home_lat, home_lng, member_type');
  const others = ((members ?? []) as (Member & { player_profile_id: string | null })[])
    .filter((m) => m.player_profile_id !== excludeProfileId);

  const ladder = discloseLadder(RADIUS_OPTIONS.map((r) => countWithinRadius(others, reference, r).total));
  const i = RADIUS_OPTIONS.indexOf(radiusMiles as (typeof RADIUS_OPTIONS)[number]);
  return i >= 0 ? ladder[i] : { value: 0, suppressed: true };
}

// POST — two identities, deliberately different in what they may do.
//
//   { prefsToken }      the player, holding their own secret: full read/write,
//                       including leaving.
//   { registrationId }  the opt-in prompt on the live round page: WRITE-ONLY,
//                       and only for a player who is not already a member.
//
// The registration path can neither read membership state nor overwrite an
// existing member's preferences or home location, and its response is byte-for
// -byte identical whether or not the player was already in the Circle — so it
// is not an "is this person in TourneyCircle?" oracle for whoever holds the id.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const service = getServiceSupabase();

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const radiusOf = (v: unknown) => { const n = Number(v ?? 25); return isValidRadius(n) ? n : 25; };
  const cadenceOf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 5 && n <= 21 ? Math.round(n) : 10; };
  const causesOf = (v: unknown) => (Array.isArray(v) ? v.filter((c: unknown) => typeof c === 'string').slice(0, 10) : []);

  // ── The player, holding their own token ──────────────────────────────────
  const prefsToken = typeof body?.prefsToken === 'string' ? body.prefsToken : '';
  if (prefsToken) {
    if (!TOKEN_RE.test(prefsToken)) return NextResponse.json({ error: PREFS_MISSING }, { status: 404 });
    const { data: m } = await service.from('tourneycircle_members')
      .select('id, player_profile_id').eq('prefs_token', prefsToken).maybeSingle();
    if (!m) return NextResponse.json({ error: PREFS_MISSING }, { status: 404 });

    // "Leave TourneyCircle" has to actually mean left. Recording a decline row
    // and keeping the membership was the old behaviour, and nothing read that
    // row — the player kept receiving paid blasts after asking to leave.
    if (body?.leave === true || body?.decline === true) {
      if (m.player_profile_id) {
        await service.from('tourneycircle_declines')
          .upsert({ player_profile_id: m.player_profile_id }, { onConflict: 'player_profile_id' });
      }
      await service.from('tourneycircle_members').delete().eq('id', m.id);
      return NextResponse.json({ ok: true, left: true });
    }

    const { error } = await service.from('tourneycircle_members').update({
      radius_miles: radiusOf(body?.radiusMiles),
      cause_preferences: causesOf(body?.causes),
      cadence_days: cadenceOf(body?.cadenceDays),
      updated_at: new Date().toISOString(),
    }).eq('id', m.id);
    if (error) return NextResponse.json({ error: 'Could not save — try again.' }, { status: 500 });
    return NextResponse.json({ ok: true, saved: true });
  }

  // ── The opt-in prompt on the live round page ─────────────────────────────
  const registrationId = typeof body?.registrationId === 'string' ? body.registrationId : '';
  if (!registrationId) return NextResponse.json({ error: 'registrationId or prefsToken required' }, { status: 400 });

  const { data: reg } = await service
    .from('registrations')
    .select('player_profile_id, contact_name, contact_email, tournament_id, registration_type')
    .eq('id', registrationId).maybeSingle();
  if (!reg) return NextResponse.json({ error: 'Unknown registration' }, { status: 404 });
  const profileId = reg.player_profile_id as string | null;
  if (!profileId) return NextResponse.json({ error: 'No player profile linked to this registration' }, { status: 409 });

  const radiusMiles = radiusOf(body?.radiusMiles);

  // "Not interested" — recorded so we never prompt again, and honoured by the
  // send path (lib/circle/send.ts). Purely suppressive: it removes nobody's
  // data, so an id-holder cannot use it to destroy a membership.
  if (body?.decline === true) {
    const { error } = await service.from('tourneycircle_declines')
      .upsert({ player_profile_id: profileId }, { onConflict: 'player_profile_id' });
    if (error) return NextResponse.json({ error: 'TourneyCircle tables missing — run migration 032' }, { status: 500 });
    return NextResponse.json({ ok: true, declined: true });
  }

  const { data: existing, error: readErr } = await service.from('tourneycircle_members')
    .select('id').eq('player_profile_id', profileId).maybeSingle();
  if (readErr) return NextResponse.json({ error: 'TourneyCircle tables missing — run migration 032' }, { status: 500 });

  // Already a member: no write at all. Their radius, causes, cadence and home
  // location are theirs to change from the emailed preferences link, and this
  // request is only proof that somebody holds a registration id. The response
  // below is identical to the create case on purpose.
  if (!existing) {
    const token = crypto.randomUUID();
    const homeLat = num(body?.homeLat);
    const homeLng = num(body?.homeLng);
    const { error } = await service.from('tourneycircle_members').insert({
      player_profile_id: profileId,
      email: reg.contact_email ?? null,
      name: reg.contact_name ?? null,
      radius_miles: radiusMiles,
      cause_preferences: causesOf(body?.causes),
      cadence_days: cadenceOf(body?.cadenceDays),
      member_type: reg.registration_type === 'sponsor' ? 'corporate' : 'individual',
      source_tournament_id: reg.tournament_id ?? null,
      prefs_token: token,
      ...(homeLat != null && homeLng != null ? { home_lat: homeLat, home_lng: homeLng } : {}),
    });
    if (error) {
      return NextResponse.json({
        error: /prefs_token/.test(error.message)
          ? 'TourneyCircle preferences are not migrated yet — run migration 046.'
          : 'TourneyCircle tables missing — run migration 032',
      }, { status: 500 });
    }
    // Opting in re-opens the door a decline closed.
    await service.from('tourneycircle_declines').delete().eq('player_profile_id', profileId);

    // The credential leaves by email and by no other route.
    if (reg.contact_email) {
      await sendCircleWelcomeEmail({
        toEmail: reg.contact_email as string,
        name: (reg.contact_name as string | null) ?? null,
        prefsUrl: prefsUrlFor(token),
        radiusMiles,
        cadenceDays: cadenceOf(body?.cadenceDays),
      }).catch(() => { /* membership stands even if the mail bounces */ });
    }
  }

  const nearby = await nearbyCount(service, (reg.tournament_id as string | null) ?? null, profileId, radiusMiles);
  return NextResponse.json({
    ok: true,
    memberCountNearby: nearby.suppressed ? null : nearby.value,
  });
}
