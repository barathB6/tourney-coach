import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Phase } from '@/lib/toc/phase';
import { contentFor, linesAtDepth } from '@/lib/guidance/content';
import { loadProfile, recordGuidanceEvent } from '@/lib/guidance/profile';
import { dueAt } from '@/lib/toc/phase';
import { sendComm } from '@/lib/comm/engine';
import type { Channel } from '@/lib/guidance/engine';

const getService = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// The volunteer portal — everything a volunteer sees and does, authenticated
// by their per-assignment invite token (the same trust model as the confirm
// page: the token IS the credential, and it only ever answers for the one
// assignment it was issued for).
//
// This is where Concept E becomes visible: the SAME task list renders at
// detailed/standard/minimal depth depending on the volunteer's computed
// profile, and every visit, tick and message feeds the next recomputation.

async function lookup(token: string) {
  if (!token || token.length < 8) return null;
  const service = getService();
  const { data } = await service.from('tournament_volunteer_assignments')
    .select('id, status, tournament_id, volunteer_id, role_template_id, volunteers(name), tournaments(name, event_date, shotgun_time)')
    .eq('invite_token', token).maybeSingle();
  if (!data) return null;
  return { service, row: data };
}

async function snapshot(found: NonNullable<Awaited<ReturnType<typeof lookup>>>) {
  const { service, row } = found;
  const tournamentId = row.tournament_id as string;
  const volunteerId = row.volunteer_id as string;

  const [profile, { data: role }, { data: tasks }, { data: completions }, { data: inbox }, { data: thread }] = await Promise.all([
    loadProfile(service, tournamentId, volunteerId),
    service.from('role_templates').select('name, description, phase').eq('id', row.role_template_id as string).maybeSingle(),
    service.from('task_templates').select('id, title, description, due_offset_hours, sort_order')
      .eq('role_template_id', row.role_template_id as string).order('sort_order'),
    service.from('volunteer_task_completions').select('task_template_id, completed_at')
      .eq('assignment_id', row.id as string),
    service.from('communication_log')
      .select('id, kind, subject, body, channel, created_at, read_at, meta')
      .eq('volunteer_id', volunteerId).eq('channel', 'in_app')
      .order('created_at', { ascending: false }).limit(30),
    service.from('volunteer_messages')
      .select('id, direction, audience, sender_name, body, created_at')
      .eq('tournament_id', tournamentId).eq('volunteer_id', volunteerId)
      .order('created_at', { ascending: true }).limit(100),
  ]);

  const t = row.tournaments as unknown as { name?: string; event_date?: string | null; shotgun_time?: string | null } | null;
  const v = row.volunteers as unknown as { name?: string } | null;
  const phase = (role?.phase === 'day_of' ? 'day_of' : 'planning') as Phase;
  const done = new Map((completions ?? []).map((c) => [c.task_template_id as string, c.completed_at as string]));

  return {
    volunteerName: v?.name ?? 'there',
    tournamentName: t?.name ?? 'the tournament',
    roleName: role?.name ?? 'Volunteer',
    roleDescription: (role?.description as string | null) ?? null,
    phase,
    status: row.status as string,
    guidance: {
      depth: profile.depth,
      cadence: profile.cadence,
      channel: profile.channel,
      experienceLevel: profile.experienceLevel,
      reasons: profile.reasons,
    },
    // Every task at THIS volunteer's depth. The full content ships too so the
    // portal can offer "show me more" without a round trip — and that click is
    // itself an engagement signal.
    tasks: (tasks ?? []).map((task) => {
      const content = contentFor(role?.name ?? '', task.title as string, task.description as string | null);
      const due = dueAt(phase, task.due_offset_hours as number | null,
        t?.event_date ?? null, t?.shotgun_time ?? null);
      return {
        id: task.id as string,
        title: task.title as string,
        lines: linesAtDepth(content, profile.depth),
        allDepths: { detailed: content.detailed, standard: content.standard, minimal: content.minimal },
        authored: content.authored,
        dueAt: due ? due.toISOString() : null,
        completedAt: done.get(task.id as string) ?? null,
      };
    }),
    inbox: (inbox ?? []).map((m) => ({
      id: m.id as string, kind: m.kind as string, subject: m.subject as string | null,
      body: m.body as string | null, createdAt: (m.created_at as string) ?? null,
      readAt: (m.read_at as string | null) ?? null,
      deliveredVia: ((m.meta as { delivered_via?: string } | null)?.delivered_via) ?? 'in_app',
    })),
    messages: (thread ?? []).map((m) => ({
      id: m.id as string, direction: m.direction as string, audience: m.audience as string,
      senderName: (m.sender_name as string | null) ?? null, body: m.body as string,
      createdAt: m.created_at as string,
    })),
  };
}

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const found = await lookup(token);
  if (!found) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 });

  // A portal view is an engagement signal — but throttled: only record one per
  // hour, or a volunteer refreshing the page would look hyper-engaged.
  const { data: recent } = await found.service.from('guidance_events')
    .select('id').eq('volunteer_id', found.row.volunteer_id as string)
    .eq('kind', 'portal_viewed')
    .gte('created_at', new Date(Date.now() - 3_600_000).toISOString()).limit(1);
  if (!(recent ?? []).length) {
    await recordGuidanceEvent(found.service, found.row.tournament_id as string,
      found.row.volunteer_id as string, 'portal_viewed');
  }

  // Opening the portal marks the in-app inbox read.
  await found.service.from('communication_log')
    .update({ read_at: new Date().toISOString(), status: 'read' })
    .eq('volunteer_id', found.row.volunteer_id as string)
    .eq('channel', 'in_app').is('read_at', null);

  return NextResponse.json(await snapshot(found));
}

const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const found = await lookup(str(body?.token, 100));
  if (!found) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 });
  const { service, row } = found;
  const tournamentId = row.tournament_id as string;
  const volunteerId = row.volunteer_id as string;
  const action = str(body?.action, 30);

  // ── Task completion — the strongest guidance signal ───────────────────────
  if (action === 'complete_task' || action === 'uncomplete_task') {
    const taskId = str(body?.taskId, 64);
    // The task must belong to THIS assignment's role — the token cannot tick
    // off another role's work.
    const { data: task } = await service.from('task_templates')
      .select('id, due_offset_hours, phase').eq('id', taskId)
      .eq('role_template_id', row.role_template_id as string).maybeSingle();
    if (!task) return NextResponse.json({ error: 'That task is not part of your role.' }, { status: 404 });

    if (action === 'complete_task') {
      const { data: t } = await service.from('tournaments')
        .select('event_date, shotgun_time').eq('id', tournamentId).maybeSingle();
      const due = dueAt((task.phase === 'day_of' ? 'day_of' : 'planning'),
        task.due_offset_hours as number | null,
        (t?.event_date as string | null) ?? null, (t?.shotgun_time as string | null) ?? null);
      await service.from('volunteer_task_completions').upsert({
        tournament_id: tournamentId, assignment_id: row.id as string,
        task_template_id: taskId,
        completed_at: new Date().toISOString(),
        completed_late: due ? Date.now() > due.getTime() : false,
      }, { onConflict: 'assignment_id,task_template_id' });
      await recordGuidanceEvent(service, tournamentId, volunteerId, 'task_completed', { taskId });
    } else {
      await service.from('volunteer_task_completions')
        .delete().eq('assignment_id', row.id as string).eq('task_template_id', taskId);
      await recordGuidanceEvent(service, tournamentId, volunteerId, 'task_uncompleted', { taskId });
    }
    return NextResponse.json(await snapshot(found));
  }

  // ── Two-way messaging ─────────────────────────────────────────────────────
  if (action === 'message') {
    const text = str(body?.body, 2000);
    if (!text) return NextResponse.json({ error: 'Write a message first.' }, { status: 400 });
    const audience = ['lead', 'organizer', 'platform'].includes(str(body?.audience, 20))
      ? str(body?.audience, 20) : 'organizer';

    const { data: vol } = await service.from('volunteers').select('name').eq('id', volunteerId).maybeSingle();
    await service.from('volunteer_messages').insert({
      tournament_id: tournamentId, volunteer_id: volunteerId,
      direction: 'from_volunteer', audience,
      sender_name: (vol?.name as string | null) ?? null, body: text,
      escalated_at: audience === 'platform' ? new Date().toISOString() : null,
    });
    await recordGuidanceEvent(service, tournamentId, volunteerId, 'message_sent', { audience });

    // Escalations leave the tournament: the platform is told directly, per the
    // admin@ escalation convention.
    if (audience === 'platform') {
      const { data: t } = await service.from('tournaments').select('name').eq('id', tournamentId).maybeSingle();
      await sendComm(service, {
        recipient: {
          volunteerId, tournamentId, name: 'TourneyCoach Support',
          email: process.env.ADMIN_ESCALATION_EMAIL || 'admin@tourneycoach.com', phone: null,
        },
        kind: 'escalation',
        subject: `Volunteer escalation — ${(t?.name as string) ?? tournamentId}`,
        body: `${(vol?.name as string) ?? 'A volunteer'} escalated to the platform:\n\n${text}`,
        channel: 'email',
      });
    }
    return NextResponse.json(await snapshot(found));
  }

  // ── Feedback — outranks every inferred signal ─────────────────────────────
  if (action === 'feedback') {
    const preferred = str(body?.preferredChannel, 10);
    await recordGuidanceEvent(service, tournamentId, volunteerId, 'feedback', {
      wantsMoreDetail: body?.wantsMoreDetail === true,
      wantsLessDetail: body?.wantsLessDetail === true,
      preferredChannel: (['sms', 'email', 'push', 'in_app'] as Channel[]).includes(preferred as Channel) ? preferred : null,
      rating: typeof body?.rating === 'number' ? Math.min(5, Math.max(1, Math.round(body.rating))) : null,
    });
    return NextResponse.json(await snapshot(found));
  }

  // ── Push subscription registration ────────────────────────────────────────
  if (action === 'subscribe_push') {
    const sub = body?.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return NextResponse.json({ error: 'That does not look like a push subscription.' }, { status: 400 });
    }
    await service.from('push_subscriptions').upsert({
      tournament_id: tournamentId, volunteer_id: volunteerId,
      endpoint: String(sub.endpoint).slice(0, 1000),
      p256dh: String(sub.keys.p256dh).slice(0, 300),
      auth: String(sub.keys.auth).slice(0, 300),
    }, { onConflict: 'endpoint' });
    await recordGuidanceEvent(service, tournamentId, volunteerId, 'feedback', { preferredChannel: 'push' });
    return NextResponse.json(await snapshot(found));
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
