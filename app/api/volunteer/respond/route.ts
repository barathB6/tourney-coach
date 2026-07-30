import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { roleStartAt } from '@/lib/toc/team';
import type { Phase } from '@/lib/toc/phase';

const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// The volunteer's side of the invitation. They have no account — the token in
// their email or text IS the credential, the same trust model as the player's
// round link (/live/[id]) and the golf pro's course link.
//
// The token is per-assignment, so it can only ever answer for the one role it
// was issued for: forwarding your text to a friend cannot decline someone
// else's role, and it cannot enumerate the roster.

async function lookup(token: string) {
  if (!token) return null;
  const service = getServiceSupabase();
  const { data } = await service.from('tournament_volunteer_assignments')
    .select('id, status, responded_at, role_template_id, volunteers(name), tournaments(name, event_date, shotgun_time)')
    .eq('invite_token', token).maybeSingle();
  if (!data) return null;

  const { data: role } = await service.from('role_templates')
    .select('name, description, phase').eq('id', data.role_template_id as string).maybeSingle();
  const { data: tasks } = await service.from('task_templates')
    .select('title, due_offset_hours').eq('role_template_id', data.role_template_id as string).order('sort_order');

  const t = data.tournaments as unknown as { name?: string; event_date?: string | null; shotgun_time?: string | null } | null;
  const v = data.volunteers as unknown as { name?: string } | null;
  const phase = ((role?.phase as Phase) ?? 'planning');
  const offsets = (tasks ?? []).map((x) => x.due_offset_hours as number | null).filter((x): x is number => x != null);
  const startsAt = roleStartAt(phase, offsets.length ? Math.min(...offsets) : null,
    t?.event_date ?? null, t?.shotgun_time ?? null);

  return { service, row: data, role, tasks: tasks ?? [], tournament: t, volunteer: v, phase, startsAt };
}

// GET — what the confirm page shows. Deliberately narrow: the volunteer's own
// name, the role, and what it involves. No roster, no other volunteers, no
// contact details for anyone.
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const found = await lookup(token);
  if (!found) return NextResponse.json({ error: 'This invitation link is not valid.' }, { status: 404 });

  return NextResponse.json({
    volunteerName: found.volunteer?.name ?? 'there',
    tournamentName: found.tournament?.name ?? 'the tournament',
    roleName: found.role?.name ?? 'a role',
    roleDescription: found.role?.description ?? null,
    phase: found.phase,
    startsAt: found.startsAt ? found.startsAt.toISOString() : null,
    tasks: found.tasks.map((t) => t.title as string),
    status: found.row.status as string,
    respondedAt: (found.row.responded_at as string | null) ?? null,
  });
}

// POST — say yes or no. Idempotent: answering twice just re-states the answer,
// and changing your mind later is allowed, because in the real world people do.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';
  const answer = body?.answer;
  if (answer !== 'confirm' && answer !== 'decline') {
    return NextResponse.json({ error: 'Answer must be confirm or decline.' }, { status: 400 });
  }

  const found = await lookup(token);
  if (!found) return NextResponse.json({ error: 'This invitation link is not valid.' }, { status: 404 });

  const status = answer === 'confirm' ? 'confirmed' : 'declined';
  const { error } = await found.service.from('tournament_volunteer_assignments')
    .update({ status, responded_at: new Date().toISOString() })
    .eq('id', found.row.id as string);
  if (error) return NextResponse.json({ error: 'Could not record your answer.' }, { status: 500 });

  return NextResponse.json({ ok: true, status });
}
