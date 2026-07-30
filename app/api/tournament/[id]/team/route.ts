import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadTeam, sendVolunteerInvite } from '@/lib/toc/team';

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

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// GET — both team libraries with their members, invite state and reminder log.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  const team = await loadTeam(gate.service, id);
  if (!team) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
  return NextResponse.json(team);
}

// POST — assign someone to a role, creating the volunteer record if they're new,
// and optionally send the invitation in the same step.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const roleId = str(body?.roleTemplateId);
  const name = str(body?.name).slice(0, 120);
  const email = str(body?.email).slice(0, 160).toLowerCase();
  const phone = str(body?.phone).slice(0, 40);

  if (!roleId) return NextResponse.json({ error: 'Pick a role first.' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 });
  // An invitation with nowhere to go is not an invitation.
  if (!email && !phone) {
    return NextResponse.json({ error: 'Add an email or a phone number so they can be invited.' }, { status: 400 });
  }

  const { data: role } = await gate.service.from('role_templates').select('id').eq('id', roleId).maybeSingle();
  if (!role) return NextResponse.json({ error: 'That role does not exist.' }, { status: 400 });

  // Reuse an existing volunteer on this tournament when the email matches —
  // one person taking three roles should be one row, so a phone-number change
  // updates every role at once.
  let volunteerId: string | null = null;
  if (email) {
    const { data: existing } = await gate.service.from('volunteers')
      .select('id').eq('tournament_id', id).ilike('email', email).maybeSingle();
    volunteerId = existing?.id ?? null;
  }
  if (!volunteerId) {
    const { data: created, error } = await gate.service.from('volunteers')
      .insert({ tournament_id: id, name, email: email || null, phone: phone || null })
      .select('id').single();
    if (error || !created) return NextResponse.json({ error: 'Could not add that volunteer.' }, { status: 500 });
    volunteerId = created.id;
  } else {
    await gate.service.from('volunteers')
      .update({ name, ...(phone ? { phone } : {}) }).eq('id', volunteerId);
  }

  const { data: assignment, error: assignErr } = await gate.service
    .from('tournament_volunteer_assignments')
    .insert({ tournament_id: id, volunteer_id: volunteerId, role_template_id: roleId, status: 'assigned' })
    .select('id').single();

  if (assignErr) {
    if (assignErr.code === '23505') {
      return NextResponse.json({ error: 'That person already holds this role.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Could not assign that role — run migration 040.' }, { status: 500 });
  }

  let invite: { ok: boolean; channels: string[]; error?: string } | null = null;
  if (body?.invite !== false) {
    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    invite = await sendVolunteerInvite(gate.service, assignment.id, origin);
  }

  const team = await loadTeam(gate.service, id);
  return NextResponse.json({ ...team, invite });
}

// PATCH — re-send an invitation, or change an assignment's status by hand
// (someone confirms verbally at a meeting rather than clicking the link).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const assignmentId = str(body?.assignmentId);
  if (!assignmentId) return NextResponse.json({ error: 'assignmentId required' }, { status: 400 });

  // Scope the assignment to THIS tournament before touching it — the id alone
  // is not proof it belongs to the caller.
  const { data: owned } = await gate.service.from('tournament_volunteer_assignments')
    .select('id').eq('id', assignmentId).eq('tournament_id', id).maybeSingle();
  if (!owned) return NextResponse.json({ error: 'That assignment is not part of this tournament.' }, { status: 404 });

  let invite: { ok: boolean; channels: string[]; error?: string } | null = null;
  if (body?.action === 'resend') {
    const origin = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    invite = await sendVolunteerInvite(gate.service, assignmentId, origin);
  } else if (body?.action === 'remove') {
    await gate.service.from('tournament_volunteer_assignments').delete().eq('id', assignmentId).eq('tournament_id', id);
  } else {
    const status = str(body?.status);
    if (!['assigned', 'confirmed', 'declined', 'completed'].includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    await gate.service.from('tournament_volunteer_assignments')
      .update({ status, responded_at: new Date().toISOString() })
      .eq('id', assignmentId).eq('tournament_id', id);
  }

  const team = await loadTeam(gate.service, id);
  return NextResponse.json({ ...team, invite });
}
