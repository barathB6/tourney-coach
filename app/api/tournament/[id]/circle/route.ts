import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { causeBreakdown, countWithinRadius, disclose, discloseLadder, expectedClicks, isValidRadius, membersWithinRadius, MIN_DISCLOSABLE_COUNT, NOTIFICATION_COST_CENTS, RADIUS_OPTIONS, type DisclosedCount, type Member } from '@/lib/tourneycircle';
import { courseCentroid, declinedProfileIds, notSuppressed, sendCircleNotification } from '@/lib/circle/send';

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

type RawMember = Member & { player_profile_id: string | null; cadence_days?: number; cause_preferences?: string[] | null };

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

  // Everything DISCLOSED below is computed from the population minus declines
  // only — NOT minus behavioral suppression.
  //
  // Behavioral suppression keys off this tournament's own registrations and
  // visits, both of which the organizer can manufacture one row at a time. If
  // the displayed count moved with it, adding a single registration for a known
  // player profile and watching the number fall by one would answer "is this
  // person in TourneyCircle?" — the 037 visit-forgery attack, wearing a
  // different hat. Suppression still governs who is actually SENT to
  // (lib/circle/send.ts), where it belongs: you never pay to notify someone
  // already registered. The estimate is therefore an upper bound, and the page
  // says so.
  const declined = await declinedProfileIds(gate.service);
  const eligible = notSuppressed((members ?? []) as RawMember[], declined);
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

  // The member_type split gets its own ladder, per type, across the same radii.
  // Passing `rawMatched` straight through once the TOTAL cleared the ladder was
  // wrong twice over: a disclosed total of 6 could carry "1 corporate", which
  // is one identifiable company; and the three sub-counts are themselves nested
  // across radii, so they difference exactly like the total does.
  const typeLadders = (['individual', 'corporate', 'coe'] as const).map((k) => ({
    key: k,
    rungs: discloseLadder(RADIUS_OPTIONS.map((r) => countWithinRadius(eligible, ref, r)[k])),
  }));
  const radiusIndex = RADIUS_OPTIONS.indexOf(radiusMiles as (typeof RADIUS_OPTIONS)[number]);
  const subCount = (k: 'individual' | 'corporate' | 'coe') => {
    if (matchedSuppressed || radiusIndex < 0) return 0;
    const rungs = typeLadders.find((t) => t.key === k)!.rungs[radiusIndex];
    return rungs.suppressed ? 0 : rungs.value;
  };
  const matched = matchedSuppressed
    ? { total: 0, individual: 0, corporate: 0, coe: 0 }
    : {
        total: rawMatched.total,
        individual: subCount('individual'),
        corporate: subCount('corporate'),
        coe: subCount('coe'),
      };
  // A sub-count withheld while the total is shown would otherwise read as a
  // hard zero. The UI needs to tell "none" from "too few to say".
  const typeBreakdownPartial = !matchedSuppressed && (['individual', 'corporate', 'coe'] as const)
    .some((k) => rawMatched[k] > 0 && subCount(k) === 0);

  // Causes are nested across radii for exactly the same reason the totals are,
  // and a per-bucket floor doesn't stop a cause counted 5 at 15mi and 6 at 25mi
  // from naming the one person in that ring. Each cause therefore runs its own
  // ladder over the radius options before the requested rung is read off.
  const causeRungs = new Map<string, DisclosedCount[]>();
  for (const r of RADIUS_OPTIONS) {
    for (const row of causeBreakdown(membersWithinRadius(eligible, ref, r))) {
      if (!causeRungs.has(row.cause)) causeRungs.set(row.cause, []);
    }
  }
  for (const cause of causeRungs.keys()) {
    const perRadius = RADIUS_OPTIONS.map((r) =>
      causeBreakdown(membersWithinRadius(eligible, ref, r)).find((x) => x.cause === cause)?.count ?? 0);
    causeRungs.set(cause, discloseLadder(perRadius));
  }
  const byCause = matchedSuppressed || radiusIndex < 0 ? [] : [...causeRungs.entries()]
    .map(([cause, rungs]) => ({ cause, ...rungs[radiusIndex] }))
    .filter((row) => !row.suppressed && row.value > 0)
    .sort((a, b) => b.value - a.value || a.cause.localeCompare(b.cause));

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
    typeBreakdownPartial,
    minDisclosableCount: MIN_DISCLOSABLE_COUNT,
    expectedClicks: expectedClicks(matched.total),
    costCents: NOTIFICATION_COST_CENTS,
    history: (history ?? []).map((h) => ({ radiusMiles: h.radius_miles, reached: h.reached_count, clicked: h.clicked_count, registered: h.registered_count, sentAt: h.sent_at })),
  });
}

// POST — the $29 send. All of the suppression / cadence / disclosure-floor
// logic lives in lib/circle/send.ts so the AI coach's send tool runs exactly
// the same rules; this handler is just auth plus HTTP shape.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const radius = Number(body?.radiusMiles ?? 25);
  const radiusMiles = isValidRadius(radius) ? radius : 25;

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const result = await sendCircleNotification({
    service: gate.service,
    tournamentId: id,
    organizerId: gate.organizerId,
    courseId: gate.courseId,
    radiusMiles,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, reached: result.reached });
}
