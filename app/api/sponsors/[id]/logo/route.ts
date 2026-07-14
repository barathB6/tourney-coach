import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Public read — the sponsors table has no anonymous SELECT policy (RLS
// scopes it to the organizer), so the public upload page can't query it
// directly the way the microsite pages query tournaments. This exposes
// only the minimal fields the upload page needs.
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = getSupabase();

  const { data: sponsor } = await supabase
    .from('sponsors')
    .select('id, company, status, logo_url, tournaments(name, microsite_color)')
    .eq('id', id)
    .single();
  if (!sponsor) {
    return NextResponse.json({ error: 'Sponsor not found' }, { status: 404 });
  }

  const tournament = sponsor.tournaments as unknown as { name: string; microsite_color: string | null } | null;
  return NextResponse.json({
    company: sponsor.company,
    status: sponsor.status,
    logoUrl: sponsor.logo_url,
    tournamentName: tournament?.name ?? null,
    micrositeColor: tournament?.microsite_color ?? null,
  });
}

// Public endpoint — a paid sponsor has no TourneyCoach login, so this is
// reached via the unguessable sponsor id link sent in their confirmation
// and logo-request emails. Only lets them attach a logo to their own row,
// nothing else.
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = getSupabase();

  const { data: sponsor } = await supabase.from('sponsors').select('id, tournament_id, status').eq('id', id).single();
  if (!sponsor) {
    return NextResponse.json({ error: 'Sponsor not found' }, { status: 404 });
  }
  if (sponsor.status !== 'paid') {
    return NextResponse.json({ error: 'Logo uploads open once your sponsorship is confirmed and paid.' }, { status: 403 });
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get('logo');
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'Please upload an image file' }, { status: 400 });
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'Logo must be under 5MB' }, { status: 400 });
  }

  const ext = file.name.split('.').pop() || 'png';
  const path = `${sponsor.tournament_id}/${sponsor.id}-${Date.now()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage.from('sponsor-logos').upload(path, buffer, {
    contentType: file.type,
    upsert: true,
  });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  const { data: pub } = supabase.storage.from('sponsor-logos').getPublicUrl(path);
  await supabase.from('sponsors').update({ logo_url: pub.publicUrl, logo_received: true }).eq('id', sponsor.id);

  return NextResponse.json({ logo_url: pub.publicUrl });
}
