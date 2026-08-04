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
  prospect_id?: string;
  volunteer_id?: string;
  comm_log_id?: string;
  timestamp?: number;
}

// SendGrid posts a batch of events (delivered, open, click, bounce, ...)
// for every tracked email. Each event carries back the custom_args we set
// at send time, so sponsor_id round-trips without needing to look up by
// message id. This closes the "response tracking: open, click" deliverable;
// reply is handled by the inbound-parse webhook, and commit/decline flow
// from the Adyen payment webhook and the organizer's status changes.
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
    const at = evt.timestamp ? new Date(evt.timestamp * 1000).toISOString() : new Date().toISOString();

    // Vendor donation outreach tags prospect_id instead of sponsor_id. This is
    // the "opened" column of the Day 28 outreach tracker: the only place it can
    // come from is SendGrid, since an organizer cannot know an email was read.
    if (evt.prospect_id) {
      if (evt.event !== 'open' && evt.event !== 'click') continue;
      const { data: p } = await supabase.from('donation_prospects')
        .select('status, email_opens, opened_at').eq('id', evt.prospect_id).maybeSingle();
      if (!p) continue;
      const patch: Record<string, unknown> = { updated_at: at };
      if (evt.event === 'open') {
        patch.email_opens = ((p.email_opens as number | null) ?? 0) + 1;
        patch.opened_at = (p.opened_at as string | null) ?? at;
      }
      // Only advance 'sent' → 'opened'. A prospect who has already replied,
      // committed or declined must not be dragged backwards by a late open
      // event — the organizer's outcome outranks an inbox pixel.
      if (p.status === 'sent') patch.status = 'opened';
      await supabase.from('donation_prospects').update(patch).eq('id', evt.prospect_id);
      continue;
    }

    // Communication Engine sends tag comm_log_id, which is what makes
    // "unopened emails" a real guidance signal rather than an assumption:
    // without an open event the ledger row simply never gets read_at.
    if (evt.comm_log_id) {
      if (evt.event !== 'open' && evt.event !== 'click') continue;
      await supabase.from('communication_log')
        .update({ read_at: at, status: 'read' })
        .eq('id', evt.comm_log_id).is('read_at', null);
      continue;
    }

    if (!evt.sponsor_id) continue;

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
