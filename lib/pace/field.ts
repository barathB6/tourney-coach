import type { SupabaseClient } from '@supabase/supabase-js';
import { computeFieldPace, GPS_FRESH_MINUTES, kitchenMessage, shouldNotifyKitchen, type FieldPace, type TeamPaceInput } from '@/lib/pace';
import { sendSms, toE164, twilioConfigured } from '@/lib/sms/twilio';

// Module 9 — loading real pace state, and the auto-fire that follows from it.
// Shared by the organizer's pace view, the score-submission hook and the cron,
// so all three agree on where every group is.

export interface LoadedPace extends FieldPace {
  tournamentName: string;
  totalHoles: number;
  kitchen: { sentAt: string | null; toPhone: string | null; message: string | null; status: string | null } | null;
  kitchenPhone: string | null;      // the pro's number from the course profile
  kitchenReady: boolean;            // configured AND we have a usable number
}

// Every playing team's progress, built from their own score submissions.
// Sponsor-type registrations are money, not a group on the course, so they
// never appear here — counting them would put phantom groups on the map and
// drag the "last group in" estimate.
export async function loadFieldPace(
  service: SupabaseClient,
  tournamentId: string,
  now: Date = new Date(),
): Promise<LoadedPace | null> {
  const { data: tournament } = await service
    .from('tournaments')
    .select('id, name, course_id')
    .eq('id', tournamentId)
    .maybeSingle();
  if (!tournament) return null;

  const [{ data: regs }, { data: scores }, { data: tracks }, { data: course }, { data: kitchen }] = await Promise.all([
    service.from('registrations')
      .select('id, team_name, contact_name, starting_hole, registration_type, payment_status')
      .eq('tournament_id', tournamentId),
    service.from('score_submissions')
      .select('registration_id, hole_number, submitted_at')
      .eq('tournament_id', tournamentId),
    // Module 8 live positions. foursome_id IS the registration in this schema
    // (see 024_gps_pipeline), so this joins straight to a team. Only recent
    // fixes matter, and the window is generous enough to survive a phone that
    // slept through a couple of ping cycles.
    service.from('gps_tracks')
      .select('foursome_id, hole_number, recorded_at')
      .eq('tournament_id', tournamentId)
      .not('hole_number', 'is', null)
      .gte('recorded_at', new Date(now.getTime() - GPS_FRESH_MINUTES * 60000).toISOString())
      .order('recorded_at', { ascending: false })
      .limit(5000),
    tournament.course_id
      ? service.from('courses').select('total_holes, contact_phone').eq('id', tournament.course_id).maybeSingle()
      : Promise.resolve({ data: null }),
    service.from('kitchen_notifications')
      .select('created_at, to_phone, message, status')
      .eq('tournament_id', tournamentId).eq('status', 'sent')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const totalHoles = (course?.total_holes as number | null) ?? 18;

  // Latest submission per (team, hole): a correction appends a row rather than
  // replacing one, so counting raw rows would inflate holes completed and
  // report groups further along than they are.
  const byTeam = new Map<string, Map<number, string>>();
  for (const s of scores ?? []) {
    const rid = s.registration_id as string;
    if (!byTeam.has(rid)) byTeam.set(rid, new Map());
    const holes = byTeam.get(rid)!;
    const prev = holes.get(s.hole_number as number);
    const at = s.submitted_at as string;
    if (!prev || Date.parse(at) > Date.parse(prev)) holes.set(s.hole_number as number, at);
  }

  // Latest fresh GPS fix per team. Rows arrive newest-first, so the first hit
  // for a registration is the one to keep.
  const gpsByTeam = new Map<string, { hole: number; at: string }>();
  for (const t of tracks ?? []) {
    const rid = t.foursome_id as string | null;
    if (!rid || gpsByTeam.has(rid)) continue;
    gpsByTeam.set(rid, { hole: t.hole_number as number, at: t.recorded_at as string });
  }

  const inputs: TeamPaceInput[] = (regs ?? [])
    .filter((r) => r.registration_type !== 'sponsor' && r.payment_status !== 'refunded')
    .map((r) => {
      const holes = byTeam.get(r.id as string);
      const times = holes ? [...holes.values()].map((t) => Date.parse(t)).sort((a, b) => a - b) : [];
      return {
        registrationId: r.id as string,
        teamName: (r.team_name as string | null) || (r.contact_name as string) || 'Unnamed team',
        startingHole: (r.starting_hole as number | null) ?? null,
        holesCompleted: holes?.size ?? 0,
        firstSubmittedAt: times.length ? new Date(times[0]).toISOString() : null,
        lastSubmittedAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
        gpsHole: gpsByTeam.get(r.id as string)?.hole ?? null,
        gpsAt: gpsByTeam.get(r.id as string)?.at ?? null,
      };
    });

  const field = computeFieldPace(inputs, now, totalHoles);
  const kitchenPhone = toE164((course?.contact_phone as string | null) ?? null);

  return {
    ...field,
    tournamentName: tournament.name as string,
    totalHoles,
    kitchen: kitchen
      ? { sentAt: kitchen.created_at as string, toPhone: kitchen.to_phone as string, message: kitchen.message as string, status: kitchen.status as string }
      : null,
    kitchenPhone,
    kitchenReady: twilioConfigured() && !!kitchenPhone,
  };
}

export interface KitchenCheckResult {
  fired: boolean;
  reason: string;
  message?: string;
  toPhone?: string;
}

// The auto-fire. Called after every score submission and from the cron; safe to
// call as often as you like. "No human action needed" is the requirement, so
// the only thing standing between this and a chef's phone buzzing twelve times
// is the unique index in migration 038 — which is why the insert happens
// BEFORE the send, and a duplicate-key error is treated as "someone else got
// there first" rather than an error.
export async function runKitchenCheck(
  service: SupabaseClient,
  tournamentId: string,
  now: Date = new Date(),
): Promise<KitchenCheckResult> {
  const field = await loadFieldPace(service, tournamentId, now);
  if (!field) return { fired: false, reason: 'tournament not found' };
  if (field.kitchen) return { fired: false, reason: 'already notified' };
  if (!shouldNotifyKitchen(field)) {
    return {
      fired: false,
      reason: field.playing === 0
        ? 'no groups on the course'
        : `last group is ~${field.minutesUntilLastFinish == null ? '?' : Math.round(field.minutesUntilLastFinish)} min out`,
    };
  }

  const message = kitchenMessage(field.tournamentName, field);
  if (!field.kitchenPhone) {
    return { fired: false, reason: 'no usable phone number on the course profile', message };
  }

  // Claim the slot first. If another instance already inserted, we lose the
  // race harmlessly and send nothing.
  const { error: claimErr } = await service.from('kitchen_notifications').insert({
    tournament_id: tournamentId,
    to_phone: field.kitchenPhone,
    message,
    status: 'sent',
    minutes_to_finish: field.minutesUntilLastFinish,
    holes_in_play: field.holesInPlay,
    groups_still_out: field.playing,
  });
  if (claimErr) {
    // 23505 = unique violation = another instance is already sending it.
    if (claimErr.code === '23505') return { fired: false, reason: 'already notified' };
    return { fired: false, reason: `could not record the notification: ${claimErr.message}` };
  }

  const sms = await sendSms({ to: field.kitchenPhone, body: message });
  if (!sms.ok) {
    // Flip the claimed row to failed so it frees the unique slot and can be
    // retried on the next score, rather than leaving a "sent" row that never
    // reached anyone.
    await service.from('kitchen_notifications')
      .update({ status: 'failed', error: sms.error })
      .eq('tournament_id', tournamentId).eq('status', 'sent');
    return { fired: false, reason: sms.error ?? 'SMS failed', message, toPhone: field.kitchenPhone };
  }

  await service.from('kitchen_notifications')
    .update({ provider_sid: sms.sid })
    .eq('tournament_id', tournamentId).eq('status', 'sent');

  return { fired: true, reason: 'kitchen notified', message, toPhone: field.kitchenPhone };
}
