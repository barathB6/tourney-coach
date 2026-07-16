import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAnthropicClient } from '@/lib/ai/anthropic';

const COACH_MODEL = 'claude-haiku-4-5';
// Token levers: sliding window over the newest turns only, tight output cap,
// pruned static prompt split from per-request context (the static block sits
// behind a cache breakpoint), and a one-line format reminder per request.
const MAX_HISTORY = 8;   // messages (4 turns), most recent
const MAX_TOKENS = 300;

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

// Static persona + knowledge base + one in-context training example. Kept
// byte-stable and module-level so the cache breakpoint on it can hit. (Haiku
// 4.5's minimum cacheable prefix is 4096 tokens, so the breakpoint is inert
// at today's size — it activates automatically if the prompt grows or the
// model tier changes. The measured savings come from the pruning itself.)
const BASE_PROMPT = `You are TourneyCoach, the AI coach for charity golf tournament organizers — a seasoned friend who has run dozens of these events. Warm, encouraging, honest, plain language, never corporate.

FORMAT — follow exactly:
- Every reply is 2-5 bullets. Each bullet starts with "- " and is one short sentence.
- Plain text only: never asterisks, bold, headings, or numbered lists.
- Lead with the direct answer, end with one clear next action, prefer specific numbers.
- If you don't know something event-specific, say so in one bullet and point them where to find out.

EXAMPLE
User: How many volunteers do I need?
You:
- About 10-15 volunteers for a 72-player event.
- Start with the people your cause serves, then board and staff, then local groups needing service hours.
- Next step: share the volunteer sign-up link from your microsite this week.

FACTS:
- First-year events typically net $5,000-$15,000; Year 3 with returning sponsors: $20,000-$35,000.
- Entry fee sweet spot: $100-$125/player ($400-$500/foursome); premium courses $150-$175.
- Sponsorships are 50-70% of revenue. Tiers: Presenting $3K-$5K, Gold $1.5K-$2.5K, Silver $750-$1K, Hole $250-$500.
- Scramble rule: teams pick up at par — saves 30-45 min.
- Double shotgun supports 128 players on a par-72.
- TourneyCircle: $29 notification to local charitable golfers, 3-5% conversion.
- Kitchen notification auto-fires 45 min before the last group finishes.

ESCALATION: if the organizer is frustrated, stuck, or asks for a person, point them to admin@tourneycoach.com — a real human replies within about one business day. Don't pretend to resolve something you can't.`;

// Per-request context: organizer contact preference + live tournament state.
// Deliberately terse — every line here is paid for on every message.
function buildContextBlock(
  tournament: Record<string, unknown> | null,
  regCount: number,
  sponsorStats: { committed: number; paid: number; raisedCents: number; prospecting: number; needsFollowUp: number; awaitingReply: number } | null,
  volunteerStats: { total: number; roles: Record<string, number>; unassigned: number } | null,
  organizerPhone: string | null,
) {
  const lines: string[] = [];
  lines.push(organizerPhone
    ? `Organizer phone on file: ${organizerPhone}. For escalation, offer "reply here and we'll call you at ${organizerPhone}" alongside email — it is their own number, never one for them to dial.`
    : 'No organizer phone on file — escalation is email only.');

  if (!tournament) return lines.join('\n');

  const daysOut = tournament.event_date
    ? Math.max(0, Math.round((new Date(tournament.event_date as string).getTime() - Date.now()) / 86400000))
    : null;
  const max = tournament.max_players as number | undefined;

  lines.push('', 'THIS TOURNAMENT (be specific to it — name it, use these numbers):');
  lines.push(`- ${tournament.name || 'Untitled'} | ${tournament.cause_org || tournament.cause_tagline || 'cause not set'} | ${tournament.location_name || 'course not set'}`);
  lines.push(`- ${tournament.event_date ? new Date(tournament.event_date as string).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Date not set'}${daysOut !== null ? ` (${daysOut} days out)` : ''} | ${tournament.format || 'format not set'} | teams of ${tournament.team_size || 4} | ${tournament.entry_fee_cents ? '$' + ((tournament.entry_fee_cents as number) / 100).toLocaleString() + '/player' : 'fee not set'} | ${tournament.status || 'draft'}`);
  lines.push(`- Registered: ${regCount}${max ? ` of ${max} (${Math.round((regCount / max) * 100)}% full)` : ''} | cause story ${tournament.cause_story_full ? 'written' : 'not started'}`);
  lines.push(sponsorStats
    ? `- Sponsors: ${sponsorStats.committed} committed ($${(sponsorStats.raisedCents / 100).toLocaleString()} paid from ${sponsorStats.paid}), ${sponsorStats.prospecting} prospecting${sponsorStats.awaitingReply > 0 ? `, ${sponsorStats.awaitingReply} awaiting your reply` : ''}${sponsorStats.needsFollowUp > 0 ? `, ${sponsorStats.needsFollowUp} overdue follow-up` : ''}`
    : '- Sponsors: no packages built yet');
  lines.push(volunteerStats
    ? `- Volunteers: ${volunteerStats.total}${Object.keys(volunteerStats.roles).length > 0 ? ` (${Object.entries(volunteerStats.roles).map(([role, n]) => `${n} ${role}`).join(', ')})` : ''}${volunteerStats.unassigned > 0 ? `, ${volunteerStats.unassigned} unassigned` : ''}`
    : '- Volunteers: none yet');
  return lines.join('\n');
}

// Cost/abuse guard on the paid Anthropic call: a burst cap (catches a buggy
// client or script looping the send button) and a daily cap (bounds total
// exposure from one compromised or leaked session). Checked against
// coach_messages directly rather than in-memory, since Vercel's serverless
// functions don't share memory across invocations/instances.
const BURST_LIMIT = 10;      // user messages
const BURST_WINDOW_MS = 60_000;
const DAILY_LIMIT = 150;     // user messages
const DAILY_WINDOW_MS = 24 * 60 * 60_000;

async function checkRateLimit(supabase: ReturnType<typeof getSupabase>, organizerId: string) {
  const now = Date.now();
  const [{ count: burstCount }, { count: dailyCount }] = await Promise.all([
    supabase.from('coach_messages')
      .select('id, coach_conversations!inner(organizer_id)', { count: 'exact', head: true })
      .eq('role', 'user')
      .eq('coach_conversations.organizer_id', organizerId)
      .gte('created_at', new Date(now - BURST_WINDOW_MS).toISOString()),
    supabase.from('coach_messages')
      .select('id, coach_conversations!inner(organizer_id)', { count: 'exact', head: true })
      .eq('role', 'user')
      .eq('coach_conversations.organizer_id', organizerId)
      .gte('created_at', new Date(now - DAILY_WINDOW_MS).toISOString()),
  ]);
  if ((burstCount ?? 0) >= BURST_LIMIT) return { limited: true, retryAfterSeconds: 60, reason: 'too many messages — please slow down' };
  if ((dailyCount ?? 0) >= DAILY_LIMIT) return { limited: true, retryAfterSeconds: 3600, reason: 'daily coaching limit reached — please try again later' };
  return { limited: false as const };
}

export async function POST(req: NextRequest) {
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rl = await checkRateLimit(supabase, user.id);
  if (rl.limited) {
    return Response.json(
      { error: `You've sent a lot of messages — ${rl.reason}.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return Response.json(
      { error: 'AI is not configured — add ANTHROPIC_API_KEY to enable coaching.' },
      { status: 503 },
    );
  }

  let body: { message: string; conversationId?: string; tournamentId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.message?.trim()) {
    return Response.json({ error: 'Message is required' }, { status: 400 });
  }

  const tournamentId = body.tournamentId;
  let conversationId = body.conversationId;

  const { data: profile } = await supabase.from('profiles').select('phone').eq('id', user.id).maybeSingle();
  const organizerPhone = profile?.phone ?? null;

  // Fetch tournament context
  let tournament: Record<string, unknown> | null = null;
  let regCount = 0;
  let sponsorStats: { committed: number; paid: number; raisedCents: number; prospecting: number; needsFollowUp: number; awaitingReply: number } | null = null;
  let volunteerStats: { total: number; roles: Record<string, number>; unassigned: number } | null = null;
  if (tournamentId) {
    const { data } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', tournamentId)
      .eq('organizer_id', user.id)
      .single();
    tournament = data;

    if (tournament) {
      const { count } = await supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId)
        .in('payment_status', ['pending', 'paid']);
      regCount = count ?? 0;

      const { data: sponsorRows } = await supabase
        .from('sponsors')
        .select('status, amount_cents')
        .eq('tournament_id', tournamentId);
      if (sponsorRows) {
        sponsorStats = {
          committed: sponsorRows.filter(s => ['paid', 'invoiced', 'verbal'].includes(s.status)).length,
          paid: sponsorRows.filter(s => s.status === 'paid').length,
          raisedCents: sponsorRows.filter(s => s.status === 'paid').reduce((sum, s) => sum + (s.amount_cents ?? 0), 0),
          prospecting: sponsorRows.filter(s => ['not_contacted', 'contacted', 'no_reply', 'replied'].includes(s.status)).length,
          needsFollowUp: sponsorRows.filter(s => s.status === 'no_reply').length,
          awaitingReply: sponsorRows.filter(s => s.status === 'replied').length,
        };
      }

      const { data: volunteerRows } = await supabase
        .from('volunteer_signups')
        .select('role')
        .eq('tournament_id', tournamentId);
      if (volunteerRows) {
        const roles: Record<string, number> = {};
        let unassigned = 0;
        for (const v of volunteerRows) {
          if (v.role && v.role.trim()) roles[v.role] = (roles[v.role] ?? 0) + 1;
          else unassigned++;
        }
        volunteerStats = { total: volunteerRows.length, roles, unassigned };
      }
    }
  }

  // Create or fetch conversation
  if (!conversationId) {
    const title = body.message.slice(0, 80).trim();
    const { data: conv, error: convErr } = await supabase
      .from('coach_conversations')
      .insert({
        organizer_id: user.id,
        tournament_id: tournamentId || null,
        title,
      })
      .select('id')
      .single();
    if (convErr || !conv) {
      return Response.json({ error: 'Failed to create conversation' }, { status: 500 });
    }
    conversationId = conv.id;
  }

  // Save user message
  await supabase.from('coach_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content: body.message.trim(),
  });

  // Sliding window over the MOST RECENT turns. (The previous query took the
  // oldest N — ascending + limit — so once a conversation grew past the cap,
  // the model was replaying stale turns and never saw the newest question.)
  const { data: history } = await supabase
    .from('coach_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY);

  const windowed = (history || []).reverse();
  // The replayed transcript must start with a user turn.
  while (windowed.length > 0 && windowed[0].role !== 'user') windowed.shift();

  const messages = windowed.map((m: { role: string; content: string }) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Paragraph-style assistant turns saved before the bullet format existed
  // bias the model back to prose in-context — recency beats instructions on
  // a model this size. A one-line reminder on the outgoing (not persisted)
  // copy of the latest user turn corrects it.
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    last.content = `${last.content}\n\n[Format: "- " bullets only, one short sentence each.]`;
  }

  // Static block first (cache breakpoint), volatile per-request context after
  // it — so the cacheable prefix stays byte-identical across requests.
  const stream = await anthropic.messages.stream({
    model: COACH_MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: 'text', text: BASE_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: buildContextBlock(tournament, regCount, sponsorStats, volunteerStats, organizerPhone) },
    ],
    messages,
  });

  let fullReply = '';
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            fullReply += chunk;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: chunk, conversationId })}\n\n`),
            );
          }
        }

        // Save assistant reply
        await supabase.from('coach_messages').insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: fullReply,
        });

        // Update conversation title and timestamp
        await supabase
          .from('coach_conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', conversationId);

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done', conversationId })}\n\n`),
        );
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stream error';
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`),
        );
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
