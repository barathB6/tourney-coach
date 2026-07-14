import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface SendGridEvent {
  event: string;
  sg_message_id?: string;
  sponsor_id?: string;
  timestamp?: number;
}

// SendGrid posts a batch of events (delivered, open, click, bounce, ...)
// for every tracked email. Each event carries back the custom_args we set
// at send time, so sponsor_id round-trips without needing to look up by
// message id. This closes the "response tracking: open, click" deliverable
// — reply/commit/decline stay organizer-driven since there's no inbound
// email parsing wired up.
export async function POST(req: NextRequest) {
  let events: SendGridEvent[];
  try {
    events = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!Array.isArray(events)) {
    return NextResponse.json({ error: 'Expected an array of events' }, { status: 400 });
  }

  const supabase = getSupabase();

  for (const evt of events) {
    if (!evt.sponsor_id) continue;
    const at = evt.timestamp ? new Date(evt.timestamp * 1000).toISOString() : new Date().toISOString();

    if (evt.event === 'open') {
      const { data: current } = await supabase.from('sponsors').select('email_opens').eq('id', evt.sponsor_id).single();
      if (current) {
        await supabase.from('sponsors').update({
          email_opens: (current.email_opens ?? 0) + 1,
          last_opened_at: at,
        }).eq('id', evt.sponsor_id);
      }
    } else if (evt.event === 'click') {
      const { data: current } = await supabase.from('sponsors').select('email_clicks').eq('id', evt.sponsor_id).single();
      if (current) {
        await supabase.from('sponsors').update({
          email_clicks: (current.email_clicks ?? 0) + 1,
          last_clicked_at: at,
        }).eq('id', evt.sponsor_id);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
