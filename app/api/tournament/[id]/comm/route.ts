import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runCadence } from '@/lib/comm/runCadence';
import { sendComm } from '@/lib/comm/engine';
import { loadProfile } from '@/lib/guidance/profile';
import type { Channel } from '@/lib/guidance/engine';

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
  const { data: t } = await service.from('tournaments').select('organizer_id, name').eq('id', tournamentId).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: 'Tournament not found' }, { status: 404 }) };
  if (t.organizer_id !== user.id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { service, tournamentName: (t.name as string) ?? '' };
}

const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// The organizer's side of the Communication Engine: message threads, guidance
// profiles, the send ledger, and the "run reminders now" trigger.
async function snapshot(service: ReturnType<typeof getServiceSupabase>, tournamentId: string) {
  const [{ data: messages }, { data: profiles }, { data: ledger }, { data: volunteers }] = await Promise.all([
    service.from('volunteer_messages')
      .select('id, volunteer_id, direction, audience, sender_name, body, escalated_at, read_at, created_at')
      .eq('tournament_id', tournamentId).order('created_at', { ascending: true }).limit(500),
    service.from('volunteer_guidance_profiles')
      .select('volunteer_id, experience_level, depth, cadence, channel, computed_at, recompute_reason')
      .eq('tournament_id', tournamentId),
    service.from('communication_log')
      .select('id, volunteer_id, channel, kind, subject, status, offset_key, error, sent_at')
      .eq('tournament_id', tournamentId).neq('channel', 'in_app')
      .order('sent_at', { ascending: false }).limit(100),
    service.from('volunteers').select('id, name').eq('tournament_id', tournamentId),
  ]);

  const nameOf = new Map((volunteers ?? []).map((v) => [v.id as string, v.name as string]));
  const threads = new Map<string, { volunteerId: string; name: string; messages: unknown[]; unread: number; escalated: boolean }>();
  for (const m of messages ?? []) {
    const vid = m.volunteer_id as string;
    if (!threads.has(vid)) threads.set(vid, { volunteerId: vid, name: nameOf.get(vid) ?? 'Unknown', messages: [], unread: 0, escalated: false });
    const th = threads.get(vid)!;
    th.messages.push({
      id: m.id as string, direction: m.direction, audience: m.audience,
      senderName: m.sender_name, body: m.body, createdAt: m.created_at,
    });
    if (m.direction === 'from_volunteer' && !m.read_at) th.unread++;
    if (m.escalated_at) th.escalated = true;
  }

  return {
    threads: [...threads.values()].sort((a, b) => (b.unread - a.unread)),
    profiles: (profiles ?? []).map((p) => ({
      volunteerId: p.volunteer_id as string,
      name: nameOf.get(p.volunteer_id as string) ?? 'Unknown',
      experienceLevel: p.experience_level, depth: p.depth, cadence: p.cadence, channel: p.channel,
      computedAt: p.computed_at, recomputeReason: p.recompute_reason,
    })),
    ledger: (ledger ?? []).map((l) => ({
      id: l.id as string, volunteerName: nameOf.get(l.volunteer_id as string) ?? '—',
      channel: l.channel, kind: l.kind, subject: l.subject, status: l.status,
      offsetKey: l.offset_key, error: l.error, sentAt: l.sent_at,
    })),
    unreadTotal: [...threads.values()].reduce((n, t) => n + t.unread, 0),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  return NextResponse.json(await snapshot(gate.service, id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const action = str(body?.action, 30);

  // Reply into a volunteer's thread — lands in-app always, plus their
  // preferred channel.
  if (action === 'reply') {
    const volunteerId = str(body?.volunteerId, 64);
    const text = str(body?.body, 2000);
    if (!text) return NextResponse.json({ error: 'Write a reply first.' }, { status: 400 });
    const { data: vol } = await gate.service.from('volunteers')
      .select('id, name, email, phone').eq('id', volunteerId).eq('tournament_id', id).maybeSingle();
    if (!vol) return NextResponse.json({ error: 'That volunteer is not on this tournament.' }, { status: 404 });

    await gate.service.from('volunteer_messages').insert({
      tournament_id: id, volunteer_id: volunteerId,
      direction: 'to_volunteer', audience: 'organizer',
      sender_name: 'Organizer', body: text,
    });

    const profile = await loadProfile(gate.service, id, volunteerId);
    await sendComm(gate.service, {
      recipient: {
        volunteerId, tournamentId: id,
        name: (vol.name as string | null) ?? null,
        email: (vol.email as string | null) ?? null,
        phone: (vol.phone as string | null) ?? null,
      },
      kind: 'reply',
      subject: `Message from your organizer — ${gate.tournamentName}`,
      body: text,
      channel: profile.channel as Channel,
    });
    return NextResponse.json(await snapshot(gate.service, id));
  }

  if (action === 'mark_read') {
    const volunteerId = str(body?.volunteerId, 64);
    await gate.service.from('volunteer_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('tournament_id', id).eq('volunteer_id', volunteerId)
      .eq('direction', 'from_volunteer').is('read_at', null);
    return NextResponse.json(await snapshot(gate.service, id));
  }

  // The manual trigger for the cadence — the honest answer to daily-only crons.
  if (action === 'run_reminders') {
    const run = await runCadence(gate.service);
    return NextResponse.json({ ...(await snapshot(gate.service, id)), run });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
