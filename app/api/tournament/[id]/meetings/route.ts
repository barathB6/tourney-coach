import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isoOrNull = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// The committee's weekly rhythm during the 12–16 week planning phase: a
// recurring agenda, who was there, and what everyone left owing.
//
// Action items carry across meetings on purpose — an item logged three weeks
// ago and still open is the single most useful thing to put in front of a
// committee, and it disappears if items are scoped to one meeting's view.
async function snapshot(service: ReturnType<typeof getServiceSupabase>, tournamentId: string) {
  const [{ data: meetings }, { data: items }, { data: volunteers }] = await Promise.all([
    service.from('planning_meetings')
      .select('id, title, scheduled_at, agenda, notes')
      .eq('tournament_id', tournamentId).order('scheduled_at', { ascending: false }).limit(50),
    service.from('meeting_action_items')
      .select('id, meeting_id, description, owner_volunteer_id, due_at, completed_at, created_at')
      .eq('tournament_id', tournamentId).order('created_at', { ascending: false }).limit(300),
    service.from('volunteers').select('id, name').eq('tournament_id', tournamentId),
  ]);

  const meetingIds = (meetings ?? []).map((m) => m.id as string);
  const { data: attendance } = meetingIds.length
    ? await service.from('meeting_attendance').select('meeting_id, volunteer_id, status').in('meeting_id', meetingIds)
    : { data: [] as { meeting_id: string; volunteer_id: string; status: string }[] };

  const nameOf = new Map((volunteers ?? []).map((v) => [v.id as string, v.name as string]));
  const attendBy = new Map<string, { volunteerId: string; name: string; status: string }[]>();
  for (const a of attendance ?? []) {
    const mid = a.meeting_id as string;
    if (!attendBy.has(mid)) attendBy.set(mid, []);
    attendBy.get(mid)!.push({
      volunteerId: a.volunteer_id as string,
      name: nameOf.get(a.volunteer_id as string) ?? 'Unknown',
      status: a.status as string,
    });
  }

  return {
    meetings: (meetings ?? []).map((m) => ({
      id: m.id as string,
      title: m.title as string,
      scheduledAt: m.scheduled_at as string,
      agenda: (m.agenda as string | null) ?? null,
      notes: (m.notes as string | null) ?? null,
      attendance: attendBy.get(m.id as string) ?? [],
    })),
    actionItems: (items ?? []).map((i) => ({
      id: i.id as string,
      meetingId: (i.meeting_id as string | null) ?? null,
      description: i.description as string,
      ownerName: i.owner_volunteer_id ? (nameOf.get(i.owner_volunteer_id as string) ?? 'Unknown') : null,
      ownerVolunteerId: (i.owner_volunteer_id as string | null) ?? null,
      dueAt: (i.due_at as string | null) ?? null,
      completedAt: (i.completed_at as string | null) ?? null,
    })),
    // The two numbers a chair actually opens the meeting with.
    openItems: (items ?? []).filter((i) => !i.completed_at).length,
    unownedItems: (items ?? []).filter((i) => !i.completed_at && !i.owner_volunteer_id).length,
    volunteers: (volunteers ?? []).map((v) => ({ id: v.id as string, name: v.name as string })),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  return NextResponse.json(await snapshot(gate.service, id));
}

// POST — schedule a meeting, or log an action item against one.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);

  if (body?.kind === 'action_item') {
    const description = str(body?.description);
    if (!description) return NextResponse.json({ error: 'Describe the action item.' }, { status: 400 });
    // A meeting id, if given, must belong to THIS tournament — an id alone is
    // not proof of ownership.
    let meetingId: string | null = null;
    if (typeof body?.meetingId === 'string' && body.meetingId) {
      const { data: m } = await gate.service.from('planning_meetings')
        .select('id').eq('id', body.meetingId).eq('tournament_id', id).maybeSingle();
      if (!m) return NextResponse.json({ error: 'That meeting is not part of this tournament.' }, { status: 400 });
      meetingId = m.id as string;
    }
    if (!meetingId) return NextResponse.json({ error: 'An action item needs a meeting.' }, { status: 400 });

    let owner: string | null = null;
    if (typeof body?.ownerVolunteerId === 'string' && body.ownerVolunteerId) {
      const { data: v } = await gate.service.from('volunteers')
        .select('id').eq('id', body.ownerVolunteerId).eq('tournament_id', id).maybeSingle();
      if (!v) return NextResponse.json({ error: 'That volunteer is not on this tournament.' }, { status: 400 });
      owner = v.id as string;
    }

    const { error } = await gate.service.from('meeting_action_items').insert({
      meeting_id: meetingId, tournament_id: id, description,
      owner_volunteer_id: owner, due_at: isoOrNull(body?.dueAt),
    });
    if (error) return NextResponse.json({ error: 'Could not log that — run migration 040.' }, { status: 500 });
    return NextResponse.json(await snapshot(gate.service, id));
  }

  const scheduledAt = isoOrNull(body?.scheduledAt);
  if (!scheduledAt) return NextResponse.json({ error: 'A meeting needs a date and time.' }, { status: 400 });

  const { data: meeting, error } = await gate.service.from('planning_meetings').insert({
    tournament_id: id,
    title: str(body?.title, 160) || 'Weekly planning meeting',
    scheduled_at: scheduledAt,
    agenda: str(body?.agenda, 4000) || null,
  }).select('id').single();
  if (error || !meeting) return NextResponse.json({ error: 'Could not schedule that — run migration 040.' }, { status: 500 });

  // Everyone holding a planning role is invited by default. The chair should
  // not have to re-pick the same committee every single week.
  const { data: planningRoles } = await gate.service.from('role_templates').select('id').eq('phase', 'planning');
  const roleIds = (planningRoles ?? []).map((r) => r.id as string);
  if (roleIds.length) {
    const { data: assigns } = await gate.service.from('tournament_volunteer_assignments')
      .select('volunteer_id').eq('tournament_id', id).in('role_template_id', roleIds).neq('status', 'declined');
    const unique = [...new Set((assigns ?? []).map((a) => a.volunteer_id as string))];
    if (unique.length) {
      await gate.service.from('meeting_attendance')
        .insert(unique.map((v) => ({ meeting_id: meeting.id, volunteer_id: v, status: 'invited' })));
    }
  }

  return NextResponse.json(await snapshot(gate.service, id));
}

// PATCH — mark attendance, complete an action item, or save meeting notes.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);

  if (body?.kind === 'attendance') {
    const status = str(body?.status, 20);
    if (!['invited', 'attended', 'absent', 'excused'].includes(status)) {
      return NextResponse.json({ error: 'Unknown attendance status' }, { status: 400 });
    }
    const { data: m } = await gate.service.from('planning_meetings')
      .select('id').eq('id', str(body?.meetingId, 64)).eq('tournament_id', id).maybeSingle();
    if (!m) return NextResponse.json({ error: 'That meeting is not part of this tournament.' }, { status: 404 });
    // The volunteer has to be on THIS tournament — same check the action-item
    // branch already makes. meeting_attendance only has an FK to the global
    // volunteers table, so without this any volunteer uuid in the system was
    // accepted: a cross-tenant row, and an existence oracle for volunteer ids
    // (a real one upserted, a fake one silently did nothing and still returned
    // 200).
    const { data: vol } = await gate.service.from('volunteers')
      .select('id').eq('id', str(body?.volunteerId, 64)).eq('tournament_id', id).maybeSingle();
    if (!vol) return NextResponse.json({ error: 'That volunteer is not on this tournament.' }, { status: 400 });
    const { error: attErr } = await gate.service.from('meeting_attendance')
      .upsert({ meeting_id: m.id, volunteer_id: vol.id, status }, { onConflict: 'meeting_id,volunteer_id' });
    if (attErr) return NextResponse.json({ error: 'Could not record attendance — run migration 040.' }, { status: 500 });
    return NextResponse.json(await snapshot(gate.service, id));
  }

  if (body?.kind === 'action_item') {
    const itemId = str(body?.itemId, 64);
    const { data: item } = await gate.service.from('meeting_action_items')
      .select('id, completed_at').eq('id', itemId).eq('tournament_id', id).maybeSingle();
    if (!item) return NextResponse.json({ error: 'That action item is not part of this tournament.' }, { status: 404 });
    // Toggle, so an item closed by mistake can be reopened.
    await gate.service.from('meeting_action_items')
      .update({ completed_at: item.completed_at ? null : new Date().toISOString() })
      .eq('id', itemId).eq('tournament_id', id);
    return NextResponse.json(await snapshot(gate.service, id));
  }

  const meetingId = str(body?.meetingId, 64);
  const { data: m } = await gate.service.from('planning_meetings')
    .select('id').eq('id', meetingId).eq('tournament_id', id).maybeSingle();
  if (!m) return NextResponse.json({ error: 'That meeting is not part of this tournament.' }, { status: 404 });
  // Only what was actually sent. Writing both fields unconditionally meant the
  // "save notes" button erased the agenda (and vice versa) — str() turns an
  // absent field into '' and the `|| null` then wrote NULL over real text.
  const patch: Record<string, string | null> = {};
  if (body?.notes !== undefined) patch.notes = str(body.notes, 8000) || null;
  if (body?.agenda !== undefined) patch.agenda = str(body.agenda, 4000) || null;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 });
  }
  await gate.service.from('planning_meetings')
    .update(patch).eq('id', meetingId).eq('tournament_id', id);
  return NextResponse.json(await snapshot(gate.service, id));
}
