import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const getServiceSupabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Records that a TourneyCircle player opened a tournament's registration page
// after being notified (/register?id=<t>&tc=<visitToken>). Drives behavioral
// suppression (don't re-notify) and the click count on the performance report.
//
// The caller proves which player they are by holding the visit token issued for
// their own notification — NOT by naming a player_profile_id. That distinction
// is the security property: an organizer can read their own registrants'
// player_profile_id, so accepting one let them forge a visit for a named person
// and then watch the matched count drop by exactly one, confirming that
// individual is a Circle member living inside the radius. A disclosure
// threshold doesn't help there — both counts are large; it's the change the
// organizer caused that leaks. The token exists only in the recipient's own
// email, so nobody else can move that number.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const service = getServiceSupabase();

  // The token resolves to the (player, tournament) pair it was issued for.
  // Nothing about that pair is echoed back to the caller.
  const { data: send, error: sendErr } = await service.from('tourneycircle_sends')
    .select('player_profile_id, tournament_id')
    .eq('visit_token', token)
    .maybeSingle();
  if (sendErr) return NextResponse.json({ error: 'TourneyCircle tables missing — run migrations 033 + 037' }, { status: 500 });
  // An unknown token gets the same response as a valid one, so this can't be
  // used to test whether a given token — or the player behind it — exists.
  if (!send) return NextResponse.json({ ok: true });

  const playerProfileId = send.player_profile_id as string;
  const tournamentId = send.tournament_id as string;

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
