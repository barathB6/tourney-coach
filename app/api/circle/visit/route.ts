import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Records that a TourneyCircle player opened a tournament's registration page
// (they arrived via their notification link, /register?id=<t>&tc=<profile>).
// Drives behavioral suppression (don't re-notify) and the click count on the
// organizer's performance report. Aggregate-only; nothing individual is exposed.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const tournamentId = typeof body?.tournamentId === 'string' ? body.tournamentId : '';
  const playerProfileId = typeof body?.playerProfileId === 'string' ? body.playerProfileId : '';
  if (!tournamentId || !playerProfileId) return NextResponse.json({ error: 'tournamentId and playerProfileId required' }, { status: 400 });

  const service = getServiceSupabase();
  // First visit for this (player, tournament) counts as a click on the most
  // recent notification blast; repeat visits don't double-count.
  const { data: existing } = await service.from('tourneycircle_visits')
    .select('id').eq('player_profile_id', playerProfileId).eq('tournament_id', tournamentId).maybeSingle();

  const { error } = await service.from('tourneycircle_visits')
    .upsert({ player_profile_id: playerProfileId, tournament_id: tournamentId }, { onConflict: 'player_profile_id,tournament_id' });
  if (error) return NextResponse.json({ error: 'TourneyCircle tables missing — run migration 033' }, { status: 500 });

  if (!existing) {
    const { data: notif } = await service.from('tourneycircle_notifications')
      .select('id, clicked_count').eq('tournament_id', tournamentId).order('sent_at', { ascending: false }).limit(1).maybeSingle();
    if (notif) await service.from('tourneycircle_notifications').update({ clicked_count: (notif.clicked_count ?? 0) + 1 }).eq('id', notif.id);
  }
  return NextResponse.json({ ok: true });
}
