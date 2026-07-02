import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateTournament, TournamentInput } from '@/lib/tournaments';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

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
      slug: generateSlug(body.name.trim()),
      event_date: body.event_date,
      course_id: body.course_id || null,
      format: body.format || 'scramble',
      max_score_rule: body.max_score_rule || 'par',
      shotgun_type: body.shotgun_type || 'double',
      max_players: body.max_players || 128,
      entry_fee_cents: body.entry_fee_cents ?? 12500,
      cause_story: body.cause_story?.trim() || null,
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
