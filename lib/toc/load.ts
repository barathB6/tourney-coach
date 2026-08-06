import type { SupabaseClient } from '@supabase/supabase-js';
import { buildGoals, dueAt, describeOffset, taskStatus, type GoalRow, type Phase, type TaskStatus } from './phase';
import { countPlayers, type HeadcountRow } from '@/lib/registrations/headcount';

// Day 26 — loading the Operations Center for one tournament.
//
// Every TOC table is service-role only (migration 025 locked them out of the
// browser), so this runs behind an owner check in the API route. Nothing here
// trusts a tournament id it wasn't handed by that check.

export interface TocTask {
  id: string;
  title: string;
  description: string | null;
  phase: Phase;
  offsetHours: number | null;
  offsetLabel: string;
  dueAt: string | null;
  status: TaskStatus;
}

export interface TocRole {
  id: string;
  name: string;
  description: string | null;
  phase: Phase;
  sortOrder: number;
  tasks: TocTask[];
  assigned: { volunteerId: string; name: string; status: string }[];
}

export interface TocSnapshot {
  tournament: { id: string; name: string; eventDate: string | null; shotgunTime: string | null };
  roles: TocRole[];
  goals: GoalRow[];
  counts: {
    planningRoles: number;
    dayOfRoles: number;
    rolesFilled: number;
    tasksOverdue: number;
    tasksDueSoon: number;
  };
}

export async function loadOperationsCenter(
  service: SupabaseClient,
  tournamentId: string,
  now: Date = new Date(),
): Promise<TocSnapshot | null> {
  const { data: tournament } = await service
    .from('tournaments')
    .select('id, name, event_date, shotgun_time')
    .eq('id', tournamentId)
    .maybeSingle();
  if (!tournament) return null;

  const eventDate = (tournament.event_date as string | null) ?? null;
  const shotgunTime = (tournament.shotgun_time as string | null) ?? null;

  const [
    { data: roleRows }, { data: taskRows }, { data: assignRows },
    { data: goalRow }, { data: regs }, { data: sponsors }, { data: donations },
    { data: comms },
  ] = await Promise.all([
    service.from('role_templates').select('id, name, description, phase, sort_order').order('sort_order'),
    service.from('task_templates').select('id, role_template_id, title, description, phase, due_offset_hours, sort_order').order('sort_order'),
    service.from('tournament_volunteer_assignments')
      .select('volunteer_id, role_template_id, status, volunteers(name)')
      .eq('tournament_id', tournamentId),
    service.from('tournament_goals').select('*').eq('tournament_id', tournamentId).maybeSingle(),
    service.from('registrations').select('registration_type, payment_status').eq('tournament_id', tournamentId),
    service.from('sponsors').select('status, amount_cents').eq('tournament_id', tournamentId),
    service.from('donation_prospects').select('id, status').eq('tournament_id', tournamentId),
    service.from('communication_log').select('id, status, channel, meta').eq('tournament_id', tournamentId),
  ]);

  // Assignments grouped by role.
  const byRole = new Map<string, { volunteerId: string; name: string; status: string }[]>();
  for (const a of assignRows ?? []) {
    const rid = a.role_template_id as string | null;
    if (!rid) continue;
    const v = a.volunteers as unknown as { name?: string } | null;
    if (!byRole.has(rid)) byRole.set(rid, []);
    byRole.get(rid)!.push({
      volunteerId: a.volunteer_id as string,
      name: v?.name ?? 'Unnamed volunteer',
      status: (a.status as string) ?? 'assigned',
    });
  }

  const tasksByRole = new Map<string, typeof taskRows>();
  for (const t of taskRows ?? []) {
    const rid = t.role_template_id as string | null;
    if (!rid) continue;
    if (!tasksByRole.has(rid)) tasksByRole.set(rid, []);
    tasksByRole.get(rid)!.push(t);
  }

  let tasksOverdue = 0;
  let tasksDueSoon = 0;

  const roles: TocRole[] = (roleRows ?? []).map((r) => {
    const phase = (r.phase as Phase) ?? 'planning';
    const tasks: TocTask[] = (tasksByRole.get(r.id as string) ?? []).map((t) => {
      const offset = (t.due_offset_hours as number | null) ?? null;
      const due = dueAt(phase, offset, eventDate, shotgunTime);
      const status = taskStatus(phase, due, now, eventDate);
      if (status === 'overdue') tasksOverdue += 1;
      if (status === 'due_soon') tasksDueSoon += 1;
      return {
        id: t.id as string,
        title: t.title as string,
        description: (t.description as string | null) ?? null,
        phase,
        offsetHours: offset,
        offsetLabel: describeOffset(phase, offset),
        dueAt: due ? due.toISOString() : null,
        status,
      };
    });
    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string | null) ?? null,
      phase,
      sortOrder: (r.sort_order as number) ?? 0,
      tasks,
      assigned: byRole.get(r.id as string) ?? [],
    };
  });

  // ── Goal actuals, all derived ─────────────────────────────────────────────
  // Players: a foursome is four people and a single is one. Sponsor-type
  // registrations are a package, not bodies on the course, so they don't count
  // toward a player goal. Refunded entries stop counting the moment they're
  // refunded — that's the whole reason progress isn't stored.
  const players = countPlayers(regs as HeadcountRow[] | null);

  // Money that is actually committed — verbal handshakes included, because the
  // committee is tracking progress toward a target, not closing the books.
  const COMMITTED = ['verbal', 'invoiced', 'paid'];
  const sponsorshipCents = (sponsors ?? [])
    .filter((s) => COMMITTED.includes(s.status as string))
    .reduce((n, s) => n + ((s.amount_cents as number | null) ?? 0), 0);

  const rolesFilled = new Set(
    (assignRows ?? [])
      .filter((a) => a.status !== 'declined')
      .map((a) => a.role_template_id as string),
  ).size;

  // "Donation items" is what has actually been SECURED, not how many vendors
  // are in the list. Counting every row meant adding a prospect you never
  // contacted — or one who said no — moved the goal bar, which is the opposite
  // of what a goal is for.
  const donationItems = (donations ?? []).filter((d) => d.status === 'committed').length;

  // Marketing reach counts DELIVERIES, once each.
  //
  // sendComm writes two ledger rows per send: the delivery row, plus an
  // unconditional in-app mirror so the volunteer portal shows everything we
  // tried to tell them. Counting the whole table therefore doubled every
  // send — and a FAILED email still scored one, because its mirror is written
  // with status 'delivered' regardless. Ten emails read as reach 20; ten
  // bounced emails read as reach 10.
  const marketingReach = (comms ?? []).filter((c) => {
    const meta = c.meta as { mirror_of?: string } | null;
    if (meta?.mirror_of) return false;   // the copy, not the send
    return c.status !== 'failed';
  }).length;

  const goals = buildGoals(goalRow as Parameters<typeof buildGoals>[0], {
    players,
    sponsorshipCents,
    donationItems,
    marketingReach,
    rolesFilled,
  });

  return {
    tournament: { id: tournament.id as string, name: tournament.name as string, eventDate, shotgunTime },
    roles,
    goals,
    counts: {
      planningRoles: roles.filter((r) => r.phase === 'planning').length,
      dayOfRoles: roles.filter((r) => r.phase === 'day_of').length,
      rolesFilled,
      tasksOverdue,
      tasksDueSoon,
    },
  };
}
