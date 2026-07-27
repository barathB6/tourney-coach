import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { centroidOf, countWithinRadius, expectedClicks, isValidRadius, NOTIFICATION_COST_CENTS, type Member } from '@/lib/tourneycircle';

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

// The course's location = the centroid of its GPS-mapped positions (real data
// from prior tournaments). Null until the course has hosted a live round.
async function courseCentroid(service: SupabaseClient, courseId: string | null) {
  if (!courseId) return null;
  const { data } = await service.from('gps_tracks').select('lat, lng').eq('course_id', courseId).limit(5000);
  return centroidOf((data ?? []).map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) })));
}

const MIGRATION_HINT = 'TourneyCircle tables missing — run db/migrations/032_tourneycircle.sql';

// GET — aggregate reach for this tournament at a given radius. Returns COUNTS
// ONLY; individual member rows never leave the service role (patent privacy).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const radius = Number(new URL(req.url).searchParams.get('radius') ?? 25);
  const radiusMiles = isValidRadius(radius) ? radius : 25;

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const ref = await courseCentroid(gate.service, gate.courseId);
  const { data: members, error } = await gate.service.from('tourneycircle_members').select('home_lat, home_lng, member_type');
  if (error) return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });

  const matched = countWithinRadius((members ?? []) as Member[], ref, radiusMiles);
  const { data: history } = await gate.service
    .from('tourneycircle_notifications').select('radius_miles, reached_count, clicked_count, registered_count, sent_at')
    .eq('tournament_id', id).order('sent_at', { ascending: false }).limit(10);

  return NextResponse.json({
    courseLocated: ref != null,
    radiusMiles,
    matched,
    expectedClicks: expectedClicks(matched.total),
    costCents: NOTIFICATION_COST_CENTS,
    history: (history ?? []).map((h) => ({
      radiusMiles: h.radius_miles, reached: h.reached_count, clicked: h.clicked_count, registered: h.registered_count, sentAt: h.sent_at,
    })),
  });
}

// POST — send one notification blast. Records the aggregate outcome row
// (reached = matched count now; clicked/registered accrue from real events).
// TourneyCoach delivers on the organizer's behalf; the organizer never sees
// recipient identities.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const radius = Number(body?.radiusMiles ?? 25);
  const radiusMiles = isValidRadius(radius) ? radius : 25;

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const ref = await courseCentroid(gate.service, gate.courseId);
  const { data: members, error } = await gate.service.from('tourneycircle_members').select('home_lat, home_lng, member_type');
  if (error) return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
  const matched = countWithinRadius((members ?? []) as Member[], ref, radiusMiles);

  if (matched.total === 0) {
    return NextResponse.json({ error: 'No matched players in range yet — nothing to send.' }, { status: 400 });
  }

  const { error: insErr } = await gate.service.from('tourneycircle_notifications').insert({
    tournament_id: id, organizer_id: gate.organizerId, radius_miles: radiusMiles,
    reached_count: matched.total, cost_cents: NOTIFICATION_COST_CENTS,
  });
  if (insErr) return NextResponse.json({ error: MIGRATION_HINT }, { status: 500 });
  return NextResponse.json({ ok: true, reached: matched.total });
}
