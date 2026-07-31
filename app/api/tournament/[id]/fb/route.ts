import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadFbPlan, saveFbInputs, refreshWeather } from '@/lib/fb/plan';
import { DEFAULT_BASELINES, type ConsumableKey } from '@/lib/fb/calculator';
import { sendKitchenSheet } from '@/lib/email/kitchenSheet';

function getAuthedSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined);
}
const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function requireOwner(req: NextRequest, tournamentId: string) {
  const { data: { user } } = await getAuthedSupabase(req).auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const service = getServiceSupabase();
  const { data: t } = await service.from('tournaments').select('organizer_id').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service };
}

const clampInt = (v: unknown, min: number, max: number) => {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  const plan = await loadFbPlan(gate.service, id);
  if (!plan) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  return NextResponse.json(plan);
}

// PATCH — edit the plan's inputs. Rejected while the headcount is locked,
// except for unlocking: the point of a lock is that the kitchen's order can't
// move underneath them.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const patch: Record<string, unknown> = {};

  const { data: existing } = await gate.service.from('fb_calculations')
    .select('headcount_locked_at').eq('tournament_id', id).maybeSingle();
  if (existing?.headcount_locked_at) {
    return NextResponse.json({ error: 'The headcount is locked. Unlock it to change the plan.' }, { status: 409 });
  }

  const vol = clampInt(body?.volunteerCount, 0, 5_000);
  if (vol != null) patch.volunteer_count = vol;
  const guests = clampInt(body?.guestCount, 0, 5_000);
  if (guests != null) patch.guest_count = guests;
  if (body?.holes === 9 || body?.holes === 18) patch.holes = body.holes;

  // A hand-typed temperature is legitimate — the organizer may know their
  // microclimate better than a grid forecast — but it must be labelled as
  // manual so the UI never implies it came from a weather service.
  if (typeof body?.temperatureF === 'number' && Number.isFinite(body.temperatureF)) {
    const t = Math.min(140, Math.max(-20, body.temperatureF));
    patch.temperature_f = t;
    patch.weather_source = 'manual';
    patch.weather_summary = `Entered by hand: ${Math.round(t)}°F.`;
    patch.weather_fetched_at = new Date().toISOString();
    const p = clampInt(body?.precipChance, 0, 100);
    patch.precip_chance = p;
  }

  if (body?.baselines && typeof body.baselines === 'object') {
    const out: Record<string, number> = {};
    for (const k of Object.keys(DEFAULT_BASELINES) as ConsumableKey[]) {
      const v = (body.baselines as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 50) out[k] = v;
    }
    patch.assumptions = out;
  }

  if (Array.isArray(body?.menu)) {
    patch.menu = (body.menu as unknown[])
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      .map((m) => m.trim().slice(0, 120)).slice(0, 20);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  try {
    await saveFbInputs(gate.service, id, patch);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not save that' }, { status: 500 });
  }
  return NextResponse.json(await loadFbPlan(gate.service, id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const action = typeof body?.action === 'string' ? body.action : '';

  try {
  if (action === 'weather') {
    const { weather, error } = await refreshWeather(gate.service, id);
    const plan = await loadFbPlan(gate.service, id);
    // Report the actual reason. A geocode miss, a missing event date and an
    // unapplied migration need three different fixes from the organizer.
    if (!weather) return NextResponse.json({ ...plan, weatherError: error ?? 'Could not look up the weather.' });
    return NextResponse.json(plan);
  }

  if (action === 'lock' || action === 'unlock') {
    const plan = await loadFbPlan(gate.service, id);
    if (!plan) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    await saveFbInputs(gate.service, id, action === 'lock'
      ? { headcount_locked_at: new Date().toISOString(), locked_player_count: plan.livePlayerCount }
      : { headcount_locked_at: null, locked_player_count: null });
    return NextResponse.json(await loadFbPlan(gate.service, id));
  }

  if (action === 'handoff') {
    const plan = await loadFbPlan(gate.service, id);
    if (!plan?.plan) {
      return NextResponse.json({ error: 'Set a headcount and a temperature before handing off to the kitchen.' }, { status: 400 });
    }
    // Handing an unlocked plan to the kitchen is how a course ends up cooking
    // for the wrong number — the count can still move after they've ordered.
    if (!plan.headcountLockedAt) {
      return NextResponse.json({ error: 'Lock the headcount first — otherwise the kitchen is ordering against a number that can still change.' }, { status: 409 });
    }
    const result = await sendKitchenSheet(gate.service, id, plan);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    await saveFbInputs(gate.service, id, {
      handed_off_at: new Date().toISOString(),
      quantities: plan.plan.lines,
      prep_timeline: plan.plan.prep,
    });
    return NextResponse.json({ ...(await loadFbPlan(gate.service, id)), handoff: result });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'That did not work' }, { status: 500 });
  }
}
