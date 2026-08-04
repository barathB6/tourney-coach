import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fireTrigger, loadTriggerState, type TriggerKind } from '@/lib/dayof/triggers';
import { dueAt } from '@/lib/toc/phase';
import type { Phase } from '@/lib/toc/phase';

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
  const { data: t } = await service.from('tournaments')
    .select('organizer_id, name, event_date, shotgun_time').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service, tournament: t };
}

// The day-of operations dashboard. Everything an organizer needs while standing
// in the clubhouse: who has arrived, where they are, what is done, who is
// stuck, and the one button that tells the right people the field has moved.
async function snapshot(
  service: ReturnType<typeof getServiceSupabase>,
  tournamentId: string,
  tournament: { name?: string; event_date?: string | null; shotgun_time?: string | null },
) {
  const [{ data: assigns }, { data: completions }, { data: messages }, { data: tasks }, triggers] = await Promise.all([
    service.from('tournament_volunteer_assignments')
      .select('id, status, volunteer_id, role_template_id, role_templates(name, phase), volunteers(name, phone, checked_in_at, last_position, last_position_at)')
      .eq('tournament_id', tournamentId),
    service.from('volunteer_task_completions')
      .select('assignment_id, task_template_id, completed_at, completed_late').eq('tournament_id', tournamentId),
    service.from('volunteer_messages')
      .select('id, volunteer_id, direction, audience, sender_name, body, escalated_at, read_at, created_at')
      .eq('tournament_id', tournamentId).eq('direction', 'from_volunteer')
      .order('created_at', { ascending: false }).limit(50),
    service.from('task_templates').select('id, role_template_id, title, due_offset_hours, phase'),
    loadTriggerState(service, tournamentId),
  ]);

  const doneByAssignment = new Map<string, Set<string>>();
  for (const c of completions ?? []) {
    const a = c.assignment_id as string;
    if (!doneByAssignment.has(a)) doneByAssignment.set(a, new Set());
    doneByAssignment.get(a)!.add(c.task_template_id as string);
  }

  const now = Date.now();
  const positions = (assigns ?? [])
    .filter((a) => (a.role_templates as unknown as { phase?: string } | null)?.phase === 'day_of')
    .map((a) => {
      const v = a.volunteers as unknown as { name?: string; phone?: string; checked_in_at?: string | null; last_position?: string | null; last_position_at?: string | null } | null;
      const role = a.role_templates as unknown as { name?: string; phase?: string } | null;
      const mine = (tasks ?? []).filter((t) => t.role_template_id === a.role_template_id);
      const done = doneByAssignment.get(a.id as string) ?? new Set<string>();
      // Overdue = past due and not ticked. This is the column an organizer
      // actually scans; everything else on the row is context for it.
      const overdue = mine.filter((t) => {
        if (done.has(t.id as string)) return false;
        const d = dueAt(((t.phase as Phase) ?? 'day_of'), t.due_offset_hours as number | null,
          tournament.event_date ?? null, tournament.shotgun_time ?? null);
        return d ? d.getTime() < now : false;
      }).length;

      return {
        assignmentId: a.id as string,
        volunteerId: a.volunteer_id as string,
        name: v?.name ?? 'Unnamed',
        phone: v?.phone ?? null,
        roleName: role?.name ?? 'Volunteer',
        status: a.status as string,
        checkedInAt: v?.checked_in_at ?? null,
        position: v?.last_position ?? null,
        positionAt: v?.last_position_at ?? null,
        tasksTotal: mine.length,
        tasksDone: done.size,
        overdue,
      };
    })
    .sort((a, b) => (b.overdue - a.overdue) || a.roleName.localeCompare(b.roleName));

  const escalations = (messages ?? []).filter((m) => !m.read_at);

  return {
    tournamentName: (tournament.name as string) ?? '',
    eventDate: tournament.event_date ?? null,
    shotgunTime: tournament.shotgun_time ?? null,
    positions,
    triggers,
    escalations: escalations.map((m) => ({
      id: m.id as string, volunteerId: m.volunteer_id as string,
      name: (m.sender_name as string | null) ?? 'A volunteer',
      audience: m.audience as string, body: m.body as string,
      escalated: !!m.escalated_at, createdAt: m.created_at as string,
    })),
    summary: {
      expected: positions.filter((p) => p.status === 'confirmed').length,
      checkedIn: positions.filter((p) => p.checkedInAt).length,
      tasksDone: positions.reduce((n, p) => n + p.tasksDone, 0),
      tasksTotal: positions.reduce((n, p) => n + p.tasksTotal, 0),
      overdue: positions.reduce((n, p) => n + p.overdue, 0),
      openEscalations: escalations.length,
    },
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  return NextResponse.json(await snapshot(gate.service, id, gate.tournament));
}

const str = (v: unknown, max = 64) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const action = str(body?.action, 30);

  if (action === 'fire') {
    const kind = str(body?.kind, 40) as TriggerKind;
    const result = await fireTrigger(gate.service, id, kind, 'organizer');
    const snap = await snapshot(gate.service, id, gate.tournament);
    if (!result.ok) return NextResponse.json({ ...snap, fireError: result.error, alreadyFired: result.alreadyFired });
    return NextResponse.json({ ...snap, fired: { kind, notified: result.notified, failed: result.failed } });
  }

  if (action === 'check_in' || action === 'undo_check_in') {
    const volunteerId = str(body?.volunteerId, 64);
    await gate.service.from('volunteers')
      .update({ checked_in_at: action === 'check_in' ? new Date().toISOString() : null })
      .eq('id', volunteerId).eq('tournament_id', id);
    return NextResponse.json(await snapshot(gate.service, id, gate.tournament));
  }

  if (action === 'resolve') {
    const messageId = str(body?.messageId, 64);
    await gate.service.from('volunteer_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('id', messageId).eq('tournament_id', id);
    return NextResponse.json(await snapshot(gate.service, id, gate.tournament));
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
