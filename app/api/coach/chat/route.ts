import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAnthropicClient } from '@/lib/ai/anthropic';

const COACH_MODEL = 'claude-sonnet-5';
const MAX_HISTORY = 40;
const MAX_TOKENS = 1024;

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

function buildSystemPrompt(
  tournament: Record<string, unknown> | null,
  regCount: number,
  sponsorStats: { committed: number; paid: number; raisedCents: number; prospecting: number; needsFollowUp: number; awaitingReply: number } | null,
) {
  const base = `You are TourneyCoach, the AI coaching assistant for charity golf tournament organizers. You are warm, encouraging, knowledgeable, and specific. You speak in plain language — never corporate, never condescending. You're like a seasoned friend who has run dozens of charity tournaments and genuinely wants this organizer to succeed.

TONE RULES:
- Positive and encouraging, but honest. If something won't work, say so kindly.
- Use "you" and "your" — this is a conversation, not a manual.
- Keep responses focused: 2-4 short paragraphs max unless the organizer asks for detail.
- Use specific numbers and actionable advice, not vague encouragement.
- Never say "let me be honest", "actually", or "to be frank" — just be direct.
- Never list more than 5 items. Prioritize ruthlessly.
- If you don't know something specific to their event, say so and suggest where to find out.

KEY FACTS YOU KNOW:
- 141,000+ charity golf events per year (NGF 2023)
- First-year events typically raise $5,000–$15,000 net
- All-event average is $29,500 (skewed by large established events)
- $4.6B total charitable giving through golf annually
- For scramble format: par is your friend — teams pick up at par to save 30–45 min
- Double shotgun start supports up to 128 players on a par-72 course
- Entry fee sweet spot for first-year: $100–$125/player ($400–$500/foursome)
- Sponsorship tiers: Presenting $3K–$5K, Gold $1.5K–$2.5K, Silver $750–$1K, Hole $250–$500
- TourneyCircle: $29 notification to matched local charitable golfers, typically 3–5% conversion
- Kitchen notification: auto-fires 45 min before last group finishes
- Normal Monday course revenue: $2,720 vs charity tournament: $9,864 guaranteed (3.6x)
- 5-year course value of a charity tournament relationship: $53,389

WHAT YOU HELP WITH:
- Tournament setup and format decisions
- Cause story and fundraising messaging
- Pricing strategy and revenue projections
- Sponsor outreach and package building
- Registration and field-filling strategy
- Volunteer coordination
- Day-of logistics and timeline
- Post-event follow-up and Year 2 planning

If the organizer asks about something outside tournament organizing (legal, tax, medical), acknowledge the question and suggest they consult the appropriate professional.`;

  if (!tournament) return base;

  const daysOut = tournament.event_date
    ? Math.max(0, Math.round((new Date(tournament.event_date as string).getTime() - Date.now()) / 86400000))
    : null;

  const context = `

CURRENT TOURNAMENT CONTEXT (use this to give specific, personalized advice):
- Tournament: ${tournament.name || 'Untitled'}
- Organization: ${tournament.organization || 'Not set'}
- Event date: ${tournament.event_date ? new Date(tournament.event_date as string).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Not set'}${daysOut !== null ? ` (${daysOut} days from now)` : ''}
- Format: ${tournament.format || 'Not set'}
- Team size: ${tournament.team_size || 4}
- Max players: ${tournament.max_players || 'Not set'}
- Entry fee: ${tournament.entry_fee ? '$' + tournament.entry_fee : 'Not set'}
- Registrations: ${regCount} players registered${tournament.max_players ? ` of ${tournament.max_players} max (${Math.round((regCount / (tournament.max_players as number)) * 100)}% full)` : ''}
- Cause story: ${tournament.cause_story_full ? 'Written' : 'Not started'}
- Status: ${tournament.status || 'draft'}
${sponsorStats ? `- Sponsors: ${sponsorStats.committed} committed ($${(sponsorStats.raisedCents / 100).toLocaleString()} paid so far from ${sponsorStats.paid} paid sponsors), ${sponsorStats.prospecting} still being prospected${sponsorStats.awaitingReply > 0 ? `, ${sponsorStats.awaitingReply} replied and awaiting the organizer's response` : ''}${sponsorStats.needsFollowUp > 0 ? `, ${sponsorStats.needsFollowUp} overdue for follow-up` : ''}` : '- Sponsors: No sponsorship packages built yet'}

Use this context to make your advice specific. Reference their tournament name, dates, and numbers when relevant. If they're 3 weeks out with low registration, be proactive about that. If they haven't set a date yet, nudge them. If they ask about sponsors, use the live sponsor pipeline numbers above — don't give generic advice when you have their actual committed/prospecting counts.`;

  return base + context;
}

export async function POST(req: NextRequest) {
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
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

  // Fetch tournament context
  let tournament: Record<string, unknown> | null = null;
  let regCount = 0;
  let sponsorStats: { committed: number; paid: number; raisedCents: number; prospecting: number; needsFollowUp: number; awaitingReply: number } | null = null;
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

  // Load conversation history (capped)
  const { data: history } = await supabase
    .from('coach_messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(MAX_HISTORY);

  const messages = (history || []).map((m: { role: string; content: string }) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const systemPrompt = buildSystemPrompt(tournament, regCount, sponsorStats);

  // Stream response
  const stream = await anthropic.messages.stream({
    model: COACH_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
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
