import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  validateTournament,
  canTransition,
  getTimestampField,
  TournamentInput,
  TournamentStatus,
  STATUSES,
} from '@/lib/tournaments';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined
  );
  return client;
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabase(req);

  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  }

  return NextResponse.json(data);
}

export async function PUT(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabase(req);

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: existing, error: fetchError } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  }

  if (existing.organizer_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Partial<TournamentInput> & { status?: TournamentStatus };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Handle status transitions
  if (body.status && body.status !== existing.status) {
    if (!STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 422 });
    }
    if (!canTransition(existing.status, body.status)) {
      return NextResponse.json(
        { error: `Cannot transition from '${existing.status}' to '${body.status}'` },
        { status: 422 }
      );
    }
  }

  // Validate field updates (merge with existing for full validation)
  const merged = { ...existing, ...body };
  const errors = validateTournament(merged);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  // Build update payload
  const update: Record<string, unknown> = {};
  const allowedFields = [
    'name', 'organization', 'event_date', 'course_id',
    'custom_course_name', 'custom_course_city', 'custom_course_state',
    'format', 'team_size', 'max_score_rule', 'shotgun_type',
    'max_players', 'entry_fee', 'cause_what', 'cause_who', 'cause_why', 'status',
  ];

  for (const field of allowedFields) {
    if (field in body) {
      update[field] = (body as Record<string, unknown>)[field];
    }
  }

  // Set timestamp for status transitions
  if (body.status && body.status !== existing.status) {
    const tsField = getTimestampField(body.status);
    if (tsField) update[tsField] = new Date().toISOString();
  }

  if (typeof update.name === 'string') update.name = update.name.trim();
  if (typeof update.organization === 'string') update.organization = update.organization.trim() || null;

  const { data, error } = await supabase
    .from('tournaments')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { errors: [{ field: 'name', message: 'You already have a tournament with this name' }] },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
