import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { isContestType } from '@/lib/contests';
import { broadcastContestUpdate } from '@/lib/realtime';

function getAuthedSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}
const getServiceSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Owned = { service: SupabaseClient; userId: string; fieldSize: number | null; courseId: string | null };
async function requireOwner(req: NextRequest, tournamentId: string): Promise<Owned | { error: NextResponse }> {
  const authed = getAuthedSupabase(req);
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const service = getServiceSupabase();
  const { data: t } = await service.from('tournaments').select('organizer_id, max_players, course_id').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service, userId: user.id, fieldSize: t.max_players ?? null, courseId: t.course_id ?? null };
}

// A single representative yardage from a hole's per-tee map (longest tee).
function yardageFromTees(tees: unknown): number | null {
  if (!tees || typeof tees !== 'object') return null;
  const nums = Object.values(tees as Record<string, unknown>).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : null;
}

const MIGRATION_HINT = { error: 'Failed to save contest (has migration 031 been run?)' };

// Coerce a value to a non-negative integer number of cents, or null.
function cents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

// GET — every contest for the tournament with its leaderboard entries attached,
// plus the field size (for the putting "of N" cap).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const { data: contests, error } = await gate.service
    .from('contest_holes').select('*').eq('tournament_id', id).order('created_at');
  if (error) return NextResponse.json({ ...MIGRATION_HINT, contests: [] }, { status: 500 });

  const ids = (contests ?? []).map((c) => c.id);
  const { data: entries } = ids.length
    ? await gate.service.from('contest_entries').select('*').in('contest_hole_id', ids).order('created_at')
    : { data: [] as Record<string, unknown>[] };

  const byContest = new Map<string, Record<string, unknown>[]>();
  for (const e of entries ?? []) {
    const k = e.contest_hole_id as string;
    if (!byContest.has(k)) byContest.set(k, []);
    byContest.get(k)!.push(e);
  }

  // Par + yardage per hole from the tournament's course, for the card meta line.
  const holeInfo = new Map<number, { par: number | null; yards: number | null }>();
  if (gate.courseId) {
    const { data: courseHoles } = await gate.service
      .from('course_holes').select('hole_number, par, tee_yardages').eq('course_id', gate.courseId);
    for (const h of courseHoles ?? []) {
      holeInfo.set(h.hole_number, { par: h.par ?? null, yards: yardageFromTees(h.tee_yardages) });
    }
  }

  return NextResponse.json({
    fieldSize: gate.fieldSize,
    contests: (contests ?? []).map((c) => ({
      ...c,
      par: c.hole_number ? holeInfo.get(c.hole_number)?.par ?? null : null,
      yards: c.hole_number ? holeInfo.get(c.hole_number)?.yards ?? null : null,
      entries: byContest.get(c.id) ?? [],
    })),
  });
}

// POST — create a contest.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !isContestType(body.contestType)) {
    return NextResponse.json({ error: 'Valid contestType required' }, { status: 400 });
  }
  const type = body.contestType;
  const needsHole = type === 'closest_to_pin' || type === 'long_drive' || type === 'hole_in_one';
  let holeNumber: number | null = null;
  if (needsHole) {
    holeNumber = Math.round(Number(body.holeNumber));
    if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18) {
      return NextResponse.json({ error: 'holeNumber must be 1-18 for this contest type' }, { status: 400 });
    }
  } else if (Number.isInteger(Number(body.holeNumber))) {
    holeNumber = Number(body.holeNumber); // putting may optionally cite a hole
  }

  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const insuranceStatus = ['none', 'quoted', 'paid'].includes(body.insuranceStatus) ? body.insuranceStatus : 'none';
  const categoryMode = ['open', 'by_gender', 'by_age'].includes(body.categoryMode) ? body.categoryMode : 'open';

  const { data, error } = await gate.service.from('contest_holes').insert({
    tournament_id: id,
    hole_number: holeNumber,
    contest_type: type,
    prize: text(body.prize),
    sponsor: text(body.sponsor, 120),
    notes: text(body.notes, 400),
    location_label: text(body.locationLabel, 120),
    prize_value_cents: cents(body.prizeValueCents),
    insurance_status: insuranceStatus,
    insurance_cost_cents: cents(body.insuranceCostCents),
    insurer: text(body.insurer, 120),
    category_mode: categoryMode,
    entry_fee_cents: cents(body.entryFeeCents),
    payout_split: text(body.payoutSplit, 40),
  }).select('id').maybeSingle();

  if (error) {
    const dup = error.code === '23505';
    return NextResponse.json(dup ? { error: 'That contest already exists on this hole' } : MIGRATION_HINT, { status: dup ? 409 : 500 });
  }
  await broadcastContestUpdate(id, { kind: 'created', contestId: data?.id });
  return NextResponse.json({ ok: true, id: data?.id });
}

// PATCH — update a contest by id: config edits, witnesses, verification, and
// winner(s). Only the fields present in the body are touched.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'Contest id required' }, { status: 400 });
  }
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const patch: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('prize')) patch.prize = text(body.prize);
  if (has('sponsor')) patch.sponsor = text(body.sponsor, 120);
  if (has('notes')) patch.notes = text(body.notes, 400);
  if (has('locationLabel')) patch.location_label = text(body.locationLabel, 120);
  if (has('prizeValueCents')) patch.prize_value_cents = cents(body.prizeValueCents);
  if (has('insuranceStatus') && ['none', 'quoted', 'paid'].includes(body.insuranceStatus)) patch.insurance_status = body.insuranceStatus;
  if (has('insuranceCostCents')) patch.insurance_cost_cents = cents(body.insuranceCostCents);
  if (has('insurer')) patch.insurer = text(body.insurer, 120);
  if (has('categoryMode') && ['open', 'by_gender', 'by_age'].includes(body.categoryMode)) patch.category_mode = body.categoryMode;
  if (has('entryFeeCents')) patch.entry_fee_cents = cents(body.entryFeeCents);
  if (has('payoutSplit')) patch.payout_split = text(body.payoutSplit, 40);
  if (has('holeNumber')) {
    const h = Math.round(Number(body.holeNumber));
    patch.hole_number = Number.isInteger(h) && h >= 1 && h <= 18 ? h : null;
  }

  // Single-winner types (hole_in_one, closest_to_pin, long_drive).
  if (has('winnerName')) {
    const name = text(body.winnerName, 120);
    patch.winner_name = name;
    patch.winner_detail = has('winnerDetail') ? text(body.winnerDetail, 120) : null;
    patch.winner_registration_id = typeof body.winnerRegistrationId === 'string' ? body.winnerRegistrationId : null;
    patch.decided_at = name ? new Date().toISOString() : null;
  }
  // Putting multi-winner payout list.
  if (has('winners')) {
    const winners = Array.isArray(body.winners)
      ? body.winners.slice(0, 10).map((w: { name?: unknown; detail?: unknown; place?: unknown }, i: number) => ({
          name: String(w?.name ?? '').slice(0, 120),
          detail: String(w?.detail ?? '').slice(0, 120),
          place: Number.isInteger(w?.place) ? (w.place as number) : i + 1,
        })).filter((w: { name: string }) => w.name)
      : [];
    patch.winners = winners;
    patch.decided_at = winners.length ? new Date().toISOString() : null;
  }
  // Hole-in-one witnesses [{ name, confirmed }].
  if (has('witnesses')) {
    patch.witnesses = Array.isArray(body.witnesses)
      ? body.witnesses.slice(0, 20).map((w: { name?: unknown; confirmed?: unknown }) => ({
          name: String(w?.name ?? '').slice(0, 120),
          confirmed: !!w?.confirmed,
        })).filter((w: { name: string }) => w.name)
      : [];
  }
  if (has('verified')) {
    patch.verified_at = body.verified ? new Date().toISOString() : null;
  }
  if (has('verificationNotes')) patch.verification_notes = text(body.verificationNotes, 400);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
  }

  const { error, count } = await gate.service
    .from('contest_holes').update(patch, { count: 'exact' }).eq('id', body.id).eq('tournament_id', id);
  if (error) return NextResponse.json(MIGRATION_HINT, { status: 500 });
  if (!count) return NextResponse.json({ error: 'Contest not found' }, { status: 404 });

  await broadcastContestUpdate(id, { kind: 'updated', contestId: body.id });
  return NextResponse.json({ ok: true });
}

// DELETE ?id=<contestId>
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contestId = new URL(req.url).searchParams.get('id') ?? '';
  if (!contestId) return NextResponse.json({ error: 'Contest id required' }, { status: 400 });
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  await gate.service.from('contest_holes').delete().eq('id', contestId).eq('tournament_id', id);
  await broadcastContestUpdate(id, { kind: 'deleted', contestId });
  return NextResponse.json({ ok: true });
}
