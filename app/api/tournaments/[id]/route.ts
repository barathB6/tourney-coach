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

// Service-role client for the DELETE handler's cleanup step — there's no
// DELETE policy on registrations/volunteer_signups for organizers (only
// SELECT/INSERT), so the RLS-respecting client above can't remove them.
const getServiceSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

  // Validate against the merged record (so cross-field rules still see the
  // full picture), but only surface errors on fields this request actually
  // changes — otherwise pre-existing stale data (e.g. an event date that's
  // since passed) would block unrelated edits like a cause story save.
  const merged = { ...existing, ...body };
  const errors = validateTournament(merged).filter((e) => e.field in body);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  // Build update payload
  const update: Record<string, unknown> = {};
  const allowedFields = [
    'name', 'organization', 'event_date', 'course_id', 'selected_tees',
    'custom_course_name', 'custom_course_city', 'custom_course_state',
    'format', 'team_size', 'max_score_rule', 'shotgun_type',
    'max_players', 'entry_fee', 'cause_what', 'cause_who', 'cause_why', 'status',
    'cause_story_answers', 'cause_story_full', 'cause_story_medium',
    'cause_story_short', 'cause_story_one_liner', 'cause_story_photo_recs',
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

export async function DELETE(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabase(req);

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: existing, error: fetchError } = await supabase
    .from('tournaments')
    .select('id, organizer_id')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  }
  if (existing.organizer_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Block deleting a tournament that has taken real payments — a paid
  // registration is a financial record that shouldn't be able to silently
  // disappear. Refund everyone first, then delete.
  const { count: paidCount } = await supabase
    .from('registrations')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', id)
    .eq('payment_status', 'paid');

  if ((paidCount ?? 0) > 0) {
    return NextResponse.json(
      { error: `This tournament has ${paidCount} paid registration${paidCount === 1 ? '' : 's'}. Refund them first, then delete.` },
      { status: 409 }
    );
  }

  // Delete dependent rows explicitly rather than relying on the DB's ON
  // DELETE CASCADE — testing found the live constraint didn't actually have
  // it (see migration 013), so this doesn't assume that fix has been
  // applied. Uses the service-role client since organizers have no DELETE
  // policy on these tables.
  const svc = getServiceSupabase();
  await svc.from('volunteer_signups').delete().eq('tournament_id', id);
  await svc.from('registrations').delete().eq('tournament_id', id);

  const { error: deleteError } = await svc
    .from('tournaments')
    .delete()
    .eq('id', id);

  if (deleteError) {
    return NextResponse.json({ error: 'Failed to delete tournament' }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
