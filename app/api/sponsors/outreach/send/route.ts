import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendSponsorOutreachEmail } from '@/lib/email/sponsorOutreach';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

// Sends the organizer-reviewed outreach draft for real via SendGrid, with
// open/click tracking tagged to the sponsor. This is the "organizer reviews
// and sends" step of the outreach engine — the /outreach route only drafts.
export async function POST(req: NextRequest) {
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sponsor_id?: string; subject?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.sponsor_id || !body.subject?.trim() || !body.body?.trim()) {
    return NextResponse.json({ error: 'sponsor_id, subject, and body are required' }, { status: 400 });
  }

  // RLS scopes this to the organizer's own sponsors
  const { data: sponsor, error: sponsorErr } = await supabase
    .from('sponsors')
    .select('id, company, contact_name, email, status, follow_up_count')
    .eq('id', body.sponsor_id)
    .single();
  if (sponsorErr || !sponsor) {
    console.error('Sponsor lookup error:', sponsorErr?.message);
    return NextResponse.json({ error: sponsorErr?.message ?? 'Sponsor not found' }, { status: sponsorErr ? 500 : 404 });
  }
  if (!sponsor.email) {
    return NextResponse.json({ error: 'This prospect has no email on file' }, { status: 400 });
  }

  const organizerName = user.user_metadata?.full_name || user.user_metadata?.name || 'Your organizer';

  try {
    const { messageId } = await sendSponsorOutreachEmail({
      to: sponsor.email,
      toName: sponsor.contact_name,
      subject: body.subject.trim(),
      bodyText: body.body.trim(),
      organizerName,
      organizerEmail: user.email,
      sponsorId: sponsor.id,
    });

    const now = new Date().toISOString();
    // First send moves a fresh prospect to "contacted"; a manually-triggered
    // send while already contacted doesn't reset the automated follow-up
    // count — that's what the /cron/sponsor-followups route owns.
    const nextStatus = sponsor.status === 'not_contacted' ? 'contacted' : sponsor.status;

    await supabase
      .from('sponsors')
      .update({
        status: nextStatus,
        outreach_sent_at: now,
        last_touch: now,
        sendgrid_message_id: messageId ?? null,
      })
      .eq('id', sponsor.id);

    return NextResponse.json({ sent: true, messageId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send email' },
      { status: 502 },
    );
  }
}
