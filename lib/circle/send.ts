import type { SupabaseClient } from '@supabase/supabase-js';
import {
  centroidOf, isValidRadius, milesToMeters, MIN_DISCLOSABLE_COUNT,
  NOTIFICATION_COST_CENTS, type Member,
} from '@/lib/tourneycircle';
import { haversineMeters } from '@/lib/gps/geo';

// The $29 TourneyCircle send, in one place.
//
// Two callers reach this: the organizer's dashboard button and the AI coach's
// send_circle_notification tool. It lives here rather than in the route handler
// so behavioral suppression, cadence enforcement and the disclosure floor can
// never drift apart between them — those three rules are the patent-critical
// part, and a second copy is a second chance to get them wrong.
//
// Callers MUST have already verified the caller owns `tournamentId`.

export interface SendResult { ok: boolean; reached: number; error?: string }

export const CIRCLE_MIGRATION_HINT = 'TourneyCircle tables missing — run migrations 032 + 033';

type RawMember = Member & { player_profile_id: string | null; cadence_days?: number };

// Course location = centroid of its GPS-mapped positions (real data). Null
// until the course has hosted a live round.
export async function courseCentroid(service: SupabaseClient, courseId: string | null) {
  if (!courseId) return null;
  const { data } = await service.from('gps_tracks').select('lat, lng').eq('course_id', courseId).limit(5000);
  return centroidOf((data ?? []).map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) })));
}

// Behavioral suppression (Concept B): players who already REGISTERED for this
// tournament, or already VISITED its registration page, are removed from its
// reach — you never pay to notify someone who's already engaged.
export async function suppressedProfileIds(service: SupabaseClient, tournamentId: string): Promise<Set<string>> {
  const [regs, visits] = await Promise.all([
    service.from('registrations').select('player_profile_id').eq('tournament_id', tournamentId),
    service.from('tourneycircle_visits').select('player_profile_id').eq('tournament_id', tournamentId),
  ]);
  const set = new Set<string>();
  for (const r of regs.data ?? []) if (typeof r.player_profile_id === 'string') set.add(r.player_profile_id);
  for (const v of visits.data ?? []) if (typeof v.player_profile_id === 'string') set.add(v.player_profile_id);
  return set;
}

// "Not interested" has to mean it. tourneycircle_declines was written by the
// opt-in prompt and then read by nothing — a player who tapped "no thanks", or
// who left the Circle, stayed in every subsequent paid blast. This is consent,
// not a nicety, so it is enforced on the send path itself rather than left to
// whichever caller remembers.
export async function declinedProfileIds(service: SupabaseClient): Promise<Set<string>> {
  const { data } = await service.from('tourneycircle_declines').select('player_profile_id');
  const set = new Set<string>();
  for (const d of data ?? []) if (typeof d.player_profile_id === 'string') set.add(d.player_profile_id);
  return set;
}

export const notSuppressed = <T extends { player_profile_id: string | null }>(members: T[], suppressed: Set<string>): T[] =>
  members.filter((m) => !(m.player_profile_id && suppressed.has(m.player_profile_id)));

export async function sendCircleNotification(opts: {
  service: SupabaseClient;
  tournamentId: string;
  organizerId: string;
  courseId: string | null;
  radiusMiles: number;
}): Promise<SendResult> {
  const { service, tournamentId, organizerId, courseId } = opts;
  const radiusMiles = isValidRadius(opts.radiusMiles) ? opts.radiusMiles : 25;

  const ref = await courseCentroid(service, courseId);
  if (!ref) return { ok: false, reached: 0, error: 'Course location not resolved yet — host a round here first.' };

  const { data: members, error } = await service.from('tourneycircle_members')
    .select('home_lat, home_lng, member_type, player_profile_id, cadence_days');
  if (error) return { ok: false, reached: 0, error: CIRCLE_MIGRATION_HINT };

  const [suppressed, declined] = await Promise.all([
    suppressedProfileIds(service, tournamentId),
    declinedProfileIds(service),
  ]);
  for (const id of declined) suppressed.add(id);
  const limit = milesToMeters(radiusMiles);
  const withinReach = notSuppressed((members ?? []) as RawMember[], suppressed).filter(
    (m) => m.home_lat != null && m.home_lng != null && haversineMeters({ lat: m.home_lat, lng: m.home_lng }, ref) <= limit,
  );

  // Cadence enforcement: skip players notified within their own cadence window.
  const ids = withinReach.map((m) => m.player_profile_id).filter((x): x is string => !!x);
  const lastSent = new Map<string, number>();
  if (ids.length) {
    const { data: sends } = await service.from('tourneycircle_sends').select('player_profile_id, sent_at').in('player_profile_id', ids);
    for (const s of sends ?? []) {
      const at = Date.parse(s.sent_at as string);
      const prev = lastSent.get(s.player_profile_id as string);
      if (!prev || at > prev) lastSent.set(s.player_profile_id as string, at);
    }
  }
  const now = Date.now();
  const recipients = withinReach.filter((m) => {
    if (!m.player_profile_id) return true;
    const last = lastSent.get(m.player_profile_id);
    return !last || now - last >= (m.cadence_days ?? 10) * 86_400_000;
  });

  // A send below the disclosure threshold is refused outright. Two reasons, and
  // both matter: the returned `reached` count would otherwise describe a group
  // small enough to be an individual, and charging $29 to notify one or two
  // people isn't a product anyone should be sold.
  //
  // The message is deliberately identical whether the shortfall is "nobody in
  // range" or "everyone is inside their cadence window" — distinguishing them
  // told the organizer whether the in-range population was non-zero, which is
  // its own free oracle.
  if (recipients.length < MIN_DISCLOSABLE_COUNT) {
    return {
      ok: false,
      reached: 0,
      error: `Not enough reachable players in this radius right now. TourneyCircle only sends once at least ${MIN_DISCLOSABLE_COUNT} players can be reached — try a wider radius, or check back as more golfers opt in.`,
    };
  }

  const { data: notif, error: insErr } = await service.from('tourneycircle_notifications').insert({
    tournament_id: tournamentId, organizer_id: organizerId, radius_miles: radiusMiles,
    reached_count: recipients.length, cost_cents: NOTIFICATION_COST_CENTS,
  }).select('id').single();
  if (insErr) return { ok: false, reached: 0, error: CIRCLE_MIGRATION_HINT };

  const nowIso = new Date().toISOString();
  const sendRows = recipients.filter((m) => m.player_profile_id).map((m) => ({
    player_profile_id: m.player_profile_id, tournament_id: tournamentId, notification_id: notif.id, sent_at: nowIso,
  }));
  // Each row gets its own visit_token (DB default). Module 25 will read those
  // back server-side to build each recipient's /register?id=<t>&tc=<token>
  // link. They are deliberately NOT returned — the organizer (or the coach
  // acting for them) triggers the send but never receives anything that maps
  // to a person.
  if (sendRows.length) await service.from('tourneycircle_sends').insert(sendRows);

  return { ok: true, reached: recipients.length };
}
