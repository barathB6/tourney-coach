import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { causeBreakdown, centroidOf, countWithinRadius, disclose, discloseLadder, expectedClicks, isValidRadius, membersWithinRadius, milesToMeters, MIN_DISCLOSABLE_COUNT, NOTIFICATION_COST_CENTS, RADIUS_OPTIONS, type Member } from '@/lib/tourneycircle';
import { haversineMeters } from '@/lib/gps/geo';

function getAuthedSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined);
}
const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

type Owned = { service: SupabaseClient; organizerId: string; courseId: string | null };
async function requireOwner(req: NextRequest, tournamentId: string): Promise<Owned | { error: NextResponse }> {
  const { data: { user } } = await getAuthedSupabase(req).auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const service = getServiceSupabase();
  const { data: t } = await service.from('tournaments').select('organizer_id, course_id').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service, organizerId: user.id, courseId: t.course_id ?? null };
}

// Course location = centroid of its GPS-mapped positions (real data). Null until
// the course has hosted a live round.
async function courseCentroid(service: SupabaseClient, courseId: string | null) {
  if (!courseId) return null;
  const { data } = await service.from('gps_tracks').select('lat, lng').eq('course_id', courseId).limit(5000);
  return centroidOf((data ?? []).map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) })));
}

// Behavioral suppression (Concept B): players who already REGISTERED for this
// tournament, or already VISITED its registration page, are removed from its
// reach — you never pay to notify someone who's already engaged.
async function suppressedProfileIds(service: SupabaseClient, tournamentId: string): Promise<Set<string>> {
  const [regs, visits] = await Promise.all([
    service.from('registrations').select('player_profile_id').eq('tournament_id', tournamentId),
    service.from('tourneycircle_visits').select('player_profile_id').eq('tournament_id', tournamentId),
  ]);
  const set = new Set<string>();
  for (const r of regs.data ?? []) if (typeof r.player_profile_id === 'string') set.add(r.player_profile_id);
  for (const v of visits.data ?? []) if (typeof v.player_profile_id === 'string') set.add(v.player_profile_id);
  return set;
}

type RawMember = Member & { player_profile_id: string | null; cadence_days?: number; cause_preferences?: string[] | null };
const notSuppressed = (members: RawMember[], suppressed: Set<string>) =>
  members.filter((m) => !(m.player_profile_id && suppressed.has(m.player_profile_id)));

const MIGRATION_HINT = 'TourneyCircle tables missing — run migrations 032 + 033';

// GET — aggregate reach for a radius, after behavioral suppression. COUNTS ONLY.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const radius = Number(new URL(req.url).searchParams.get('radius') ?? 25);
  const radiusMiles = isValidRadius(radius) ? radius : 25;

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const ref = await courseCentroid(gate.service, gate.courseId);
  const { data: members, error } = await gate.service.from('tourneycircle_members').select('home_lat, home_lng, member_type, player_profile_id, cause_preferences');
  if (error) return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
  const eligible = notSuppressed((members ?? []) as RawMember[], await suppressedProfileIds(gate.service, id));
  const rawMatched = countWithinRadius(eligible, ref, radiusMiles);

  // Nested radii need the laddered rule, not a per-bucket floor: two totals that
  // each clear the threshold can still be subtracted to expose the ring between
  // them.
  const rawByRadius = RADIUS_OPTIONS.map((r) => countWithinRadius(eligible, ref, r).total);
  const byRadius = discloseLadder(rawByRadius).map((d, i) => ({ radiusMiles: RADIUS_OPTIONS[i], ...d }));

  // The headline `matched` is governed by that SAME ladder, not by a standalone
  // floor. radius is a query param, so an organizer can request each radius in
  // turn and read `matched.total` every time — which reconstructs the exact
  // ladder the breakdown withholds, and a difference of one is a person. A
  // per-bucket floor doesn't catch it (7, 8 and 9 all clear the floor). Reusing
  // the ladder entry for the requested radius keeps the two views consistent by
  // construction, so neither can be played off against the other.
  const rung = byRadius.find((r) => r.radiusMiles === radiusMiles);
  const matchedSuppressed = rung ? rung.suppressed : disclose(rawMatched.total).suppressed;
  const matched = matchedSuppressed
    ? { total: 0, individual: 0, corporate: 0, coe: 0 }
    : rawMatched;

  const byCause = causeBreakdown(membersWithinRadius(eligible, ref, radiusMiles))
    .map((row) => ({ cause: row.cause, ...disclose(row.count) }))
    .filter((row) => !row.suppressed);

  const { data: history } = await gate.service
    .from('tourneycircle_notifications').select('radius_miles, reached_count, clicked_count, registered_count, sent_at')
    .eq('tournament_id', id).order('sent_at', { ascending: false }).limit(10);

  return NextResponse.json({
    courseLocated: ref != null,
    radiusMiles,
    matched,
    matchedSuppressed,
    byRadius,
    byCause,
    minDisclosableCount: MIN_DISCLOSABLE_COUNT,
    expectedClicks: expectedClicks(matched.total),
    costCents: NOTIFICATION_COST_CENTS,
    history: (history ?? []).map((h) => ({ radiusMiles: h.radius_miles, reached: h.reached_count, clicked: h.clicked_count, registered: h.registered_count, sentAt: h.sent_at })),
  });
}

// POST — the $29 send. Filters to eligible recipients (in radius, not suppressed,
// and outside each player's cadence window), logs one per-player send row each
// (for cadence + performance) and one aggregate notification row. TourneyCoach
// delivers on the organizer's behalf; recipient identities never surface.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const radius = Number(body?.radiusMiles ?? 25);
  const radiusMiles = isValidRadius(radius) ? radius : 25;

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const ref = await courseCentroid(gate.service, gate.courseId);
  if (!ref) return NextResponse.json({ error: 'Course location not resolved yet — host a round here first.' }, { status: 400 });

  const { data: members, error } = await gate.service.from('tourneycircle_members').select('home_lat, home_lng, member_type, player_profile_id, cadence_days');
  if (error) return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });

  const suppressed = await suppressedProfileIds(gate.service, id);
  const limit = milesToMeters(radiusMiles);
  const withinReach = notSuppressed((members ?? []) as RawMember[], suppressed).filter(
    (m) => m.home_lat != null && m.home_lng != null && haversineMeters({ lat: m.home_lat, lng: m.home_lng }, ref) <= limit,
  );

  // Cadence enforcement: skip players notified within their own cadence window.
  const ids = withinReach.map((m) => m.player_profile_id).filter((x): x is string => !!x);
  const lastSent = new Map<string, number>();
  if (ids.length) {
    const { data: sends } = await gate.service.from('tourneycircle_sends').select('player_profile_id, sent_at').in('player_profile_id', ids);
    for (const s of sends ?? []) {
      const t = Date.parse(s.sent_at as string);
      const prev = lastSent.get(s.player_profile_id as string);
      if (!prev || t > prev) lastSent.set(s.player_profile_id as string, t);
    }
  }
  const now = Date.now();
  const recipients = withinReach.filter((m) => {
    if (!m.player_profile_id) return true;
    const last = lastSent.get(m.player_profile_id);
    return !last || now - last >= (m.cadence_days ?? 10) * 86_400_000;
  });

  // A send below the disclosure threshold is refused outright. Two reasons, and
  // both matter: the returned `reached` count would otherwise describe a group
  // small enough to be an individual, and charging $29 to notify one or two
  // people isn't a product anyone should be sold.
  //
  // The message is deliberately identical whether the shortfall is "nobody in
  // range" or "everyone is inside their cadence window" — distinguishing them
  // told the organizer whether the in-range population was non-zero, which is
  // its own free oracle.
  if (recipients.length < MIN_DISCLOSABLE_COUNT) {
    return NextResponse.json({
      error: `Not enough reachable players in this radius right now. TourneyCircle only sends once at least ${MIN_DISCLOSABLE_COUNT} players can be reached — try a wider radius, or check back as more golfers opt in.`,
    }, { status: 400 });
  }

  const { data: notif, error: insErr } = await gate.service.from('tourneycircle_notifications').insert({
    tournament_id: id, organizer_id: gate.organizerId, radius_miles: radiusMiles,
    reached_count: recipients.length, cost_cents: NOTIFICATION_COST_CENTS,
  }).select('id').single();
  if (insErr) return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });

  const nowIso = new Date().toISOString();
  const sendRows = recipients.filter((m) => m.player_profile_id).map((m) => ({
    player_profile_id: m.player_profile_id, tournament_id: id, notification_id: notif.id, sent_at: nowIso,
  }));
  // Each row gets its own visit_token (DB default). Module 25 will read those
  // back server-side to build each recipient's /register?id=<t>&tc=<token>
  // link. They are deliberately NOT returned here — the organizer triggers the
  // send but never receives anything that maps to a person.
  if (sendRows.length) await gate.service.from('tourneycircle_sends').insert(sendRows);

  return NextResponse.json({ ok: true, reached: recipients.length });
}
