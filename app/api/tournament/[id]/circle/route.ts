import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { causeBreakdown, countWithinRadius, disclose, discloseLadder, expectedClicks, isValidRadius, membersWithinRadius, MIN_DISCLOSABLE_COUNT, NOTIFICATION_COST_CENTS, RADIUS_OPTIONS, type Member } from '@/lib/tourneycircle';
import { courseCentroid, notSuppressed, sendCircleNotification, suppressedProfileIds } from '@/lib/circle/send';

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
