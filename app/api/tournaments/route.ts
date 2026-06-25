import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateTournament, TournamentInput } from '@/lib/tournaments';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined
  );
  return client;
}

export async function POST(req: NextRequest) {
  const supabase = getSupabase(req);

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: TournamentInput;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const errors = validateTournament(body);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  const { data, error } = await supabase
    .from('tournaments')
    .insert({
      organizer_id: user.id,
      name: body.name.trim(),
      organization: body.organization?.trim() || null,
      event_date: body.event_date,
      course_id: body.course_id || null,
      custom_course_name: body.custom_course_name?.trim() || null,
      custom_course_city: body.custom_course_city?.trim() || null,
      custom_course_state: body.custom_course_state?.trim() || null,
      format: body.format || 'scramble',
      team_size: body.team_size || 4,
      max_score_rule: body.max_score_rule || 'par',
      shotgun_type: body.shotgun_type || 'double',
      max_players: body.max_players || 128,
      entry_fee: body.entry_fee ?? 125,
      cause_what: body.cause_what?.trim() || null,
      cause_who: body.cause_who?.trim() || null,
      cause_why: body.cause_why?.trim() || null,
      status: 'draft',
    })
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

  return NextResponse.json(data, { status: 201 });
}
