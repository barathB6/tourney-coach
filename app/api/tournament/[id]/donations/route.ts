import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadDonations, draftForProspect, sendDonationOutreach } from '@/lib/donations/outreach';
import { VENDOR_CATEGORY_KEYS } from '@/lib/donations/vendors';

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

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;
  return NextResponse.json(await loadDonations(gate.service, id));
}

// POST — add a prospect to the list.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const company = str(body?.company, 160);
  const category = str(body?.category, 60);
  const email = str(body?.email, 160).toLowerCase();

  if (!company) return NextResponse.json({ error: 'A business name is required.' }, { status: 400 });
  if (!VENDOR_CATEGORY_KEYS.includes(category as never)) {
    return NextResponse.json({ error: 'Pick a vendor category.' }, { status: 400 });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'That email address does not look right.' }, { status: 400 });
  }

  const { error } = await gate.service.from('donation_prospects').insert({
    tournament_id: id,
    // `name` is the Day-2 column and is NOT NULL in some installs; company is
    // what we actually display, so seed both.
    name: str(body?.contactName, 120) || company,
    company,
    contact_name: str(body?.contactName, 120) || null,
    email: email || null,
    phone: str(body?.phone, 40) || null,
    category,
    notes: str(body?.notes, 2000) || null,
    status: 'prospect',
  });
  if (error) {
    return NextResponse.json({ error: 'Could not add that prospect — run migration 041.' }, { status: 500 });
  }

  return NextResponse.json(await loadDonations(gate.service, id));
}

// PATCH — draft, send, or record an outcome.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if ('error' in gate) return gate.error;

  const body = await req.json().catch(() => null);
  const prospectId = str(body?.prospectId, 64);
  const action = str(body?.action, 40);
  if (!prospectId) return NextResponse.json({ error: 'prospectId required' }, { status: 400 });

  // An id alone is not proof of ownership — scope it to this tournament first.
  const { data: owned } = await gate.service.from('donation_prospects')
    .select('id, status').eq('id', prospectId).eq('tournament_id', id).maybeSingle();
  if (!owned) return NextResponse.json({ error: 'That prospect is not part of this tournament.' }, { status: 404 });

  if (action === 'draft') {
    try {
      const draft = await draftForProspect(gate.service, id, prospectId, str(body?.mode) === 'followup');
      return NextResponse.json({ ...(await loadDonations(gate.service, id)), draft });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not draft that email.' }, { status: 502 });
    }
  }

  if (action === 'send') {
    const result = await sendDonationOutreach(gate.service, id, prospectId, {
      subject: str(body?.subject, 300) || undefined,
      body: typeof body?.body === 'string' ? body.body.trim().slice(0, 8000) : undefined,
    });
    const snapshot = await loadDonations(gate.service, id);
    if (!result.ok) return NextResponse.json({ ...snapshot, sendError: result.error }, { status: 502 });
    return NextResponse.json({ ...snapshot, sent: true });
  }

  if (action === 'status') {
    const status = str(body?.status, 20);
    if (!['prospect', 'sent', 'opened', 'responded', 'committed', 'declined'].includes(status)) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status, updated_at: now };
    if (status === 'committed') {
      patch.committed_at = now;
      const cents = typeof body?.committedValueCents === 'number' && Number.isFinite(body.committedValueCents)
        ? Math.max(0, Math.round(body.committedValueCents)) : null;
      if (cents != null) patch.committed_value_cents = cents;
      patch.declined_at = null;
    } else if (status === 'declined') {
      patch.declined_at = now;
      patch.committed_at = null;
    } else if (status === 'responded') {
      patch.responded_at = now;
    }
    await gate.service.from('donation_prospects').update(patch).eq('id', prospectId).eq('tournament_id', id);
    return NextResponse.json(await loadDonations(gate.service, id));
  }

  if (action === 'delete') {
    await gate.service.from('donation_outreach_log').delete().eq('prospect_id', prospectId).eq('tournament_id', id);
    await gate.service.from('donation_prospects').delete().eq('id', prospectId).eq('tournament_id', id);
    return NextResponse.json(await loadDonations(gate.service, id));
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
