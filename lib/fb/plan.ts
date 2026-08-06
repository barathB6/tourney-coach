// Loading and saving a tournament's F&B plan.
//
// Quantities are derived on read, never trusted from storage — the same rule
// the goals dashboard follows. What IS stored is the *inputs*: headcount,
// temperature, per-player assumptions, menu. That way a model improvement
// reaches every plan, while a plan still reproduces exactly because its inputs
// are pinned.
//
// The headcount lock is the exception that proves it. Registrations keep
// moving until the last week, but the kitchen has to order against a number.
// Locking copies the live player count into locked_player_count and the plan
// stops tracking registrations. Unlocking resumes.

import type { SupabaseClient } from '@supabase/supabase-js';
import { calculateFb, type FbPlan, type ConsumableKey, DEFAULT_BASELINES } from '@/lib/fb/calculator';
import { countPlayers, type HeadcountRow } from '@/lib/registrations/headcount';
import { getEventWeather, geocodeAddress, type EventWeather } from '@/lib/fb/weather';
import { ASSUMED_MIN_PER_HOLE } from '@/lib/pace';
import { parseShotgunTime } from '@/lib/shotgunTime';

// Re-exported: this used to be defined here and several modules import it
// from this path.
export { parseShotgunTime } from '@/lib/shotgunTime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

export interface FbPlanRecord {
  tournamentId: string;
  tournamentName: string | null;
  eventDate: string | null;
  shotgunTime: string | null;
  shotgunAt: string | null;
  /** Live count from registrations, always shown even when locked, so drift is visible. */
  livePlayerCount: number;
  lockedPlayerCount: number | null;
  headcountLockedAt: string | null;
  handedOffAt: string | null;
  volunteerCount: number;
  guestCount: number;
  holes: number;
  weather: {
    temperatureF: number | null;
    precipChance: number | null;
    source: string | null;
    summary: string | null;
    fetchedAt: string | null;
  };
  baselines: Record<ConsumableKey, number>;
  menu: string[];
  plan: FbPlan | null;
  hasCoordinates: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;

/** Default shotgun hour when the tournament has no usable time on it. */
export const DEFAULT_SHOTGUN_HOUR = 8;

/**
 * Parse a shotgun time to an hour and minute.
 *
 * `tournaments.shotgun_time` is free text, and real rows in this database hold
 * "8:30 am" and "8:30 AM" — not "08:30". An earlier version of this only
 * accepted zero-padded 24-hour times, so every real tournament silently fell
 * back to 8:00 and the entire kitchen timeline shifted by half an hour.
 * Returns null when there is genuinely nothing parseable.
 */


/** Combine an event date and a shotgun time into an ISO instant. */
export function shotgunInstant(eventDate: string | null, shotgunTime: string | null): string | null {
  if (!eventDate) return null;
  const t = parseShotgunTime(shotgunTime) ?? { hour: DEFAULT_SHOTGUN_HOUR, minute: 0 };
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  const parsed = Date.parse(`${eventDate.slice(0, 10)}T${hh}:${mm}:00Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export async function loadFbPlan(service: DB, tournamentId: string): Promise<FbPlanRecord | null> {
  const { data: t } = await service.from('tournaments')
    .select('id, name, event_date, shotgun_time, course_id')
    .eq('id', tournamentId).maybeSingle();
  if (!t) return null;

  const [{ data: row }, { data: regs }, { data: course }] = await Promise.all([
    service.from('fb_calculations').select('*').eq('tournament_id', tournamentId).maybeSingle(),
    service.from('registrations').select('registration_type, payment_status').eq('tournament_id', tournamentId),
    t.course_id
      ? service.from('courses').select('latitude, longitude').eq('id', t.course_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const livePlayerCount = countPlayers(regs as HeadcountRow[] | null);
  const lockedAt = (row?.headcount_locked_at as string | null) ?? null;
  const lockedCount = num(row?.locked_player_count);
  const effectivePlayers = lockedAt && lockedCount != null ? lockedCount : livePlayerCount;

  const storedBaselines = (row?.assumptions as Record<string, unknown> | null) ?? null;
  const baselines = { ...DEFAULT_BASELINES };
  for (const k of Object.keys(DEFAULT_BASELINES) as ConsumableKey[]) {
    const v = num(storedBaselines?.[k]);
    if (v != null && v >= 0) baselines[k] = v;
  }

  const menuRaw = row?.menu as unknown;
  const menu = Array.isArray(menuRaw) ? menuRaw.filter((m): m is string => typeof m === 'string') : [];

  const eventDate = (t.event_date as string | null) ?? null;
  const shotgunTime = (t.shotgun_time as string | null) ?? null;
  const shotgunAt = shotgunInstant(eventDate, shotgunTime);
  const holes = num(row?.holes) === 9 ? 9 : 18;
  const tempF = num(row?.temperature_f);

  return {
    tournamentId,
    tournamentName: (t.name as string | null) ?? null,
    eventDate,
    shotgunTime,
    shotgunAt,
    livePlayerCount,
    lockedPlayerCount: lockedAt ? lockedCount : null,
    headcountLockedAt: lockedAt,
    handedOffAt: (row?.handed_off_at as string | null) ?? null,
    volunteerCount: num(row?.volunteer_count) ?? 0,
    guestCount: num(row?.guest_count) ?? 0,
    holes,
    weather: {
      temperatureF: tempF,
      precipChance: num(row?.precip_chance),
      source: (row?.weather_source as string | null) ?? null,
      summary: (row?.weather_summary as string | null) ?? null,
      fetchedAt: (row?.weather_fetched_at as string | null) ?? null,
    },
    baselines,
    menu,
    // No temperature means no plan. We do not default to 75°F and present the
    // result as if it were weather-adjusted — the organizer fetches a forecast
    // or types a number.
    plan: tempF == null ? null : calculateFb({
      playerCount: effectivePlayers,
      volunteerCount: num(row?.volunteer_count) ?? 0,
      guestCount: num(row?.guest_count) ?? 0,
      holes,
      temperatureF: tempF,
      precipChance: num(row?.precip_chance),
      baselines,
      menu,
      shotgunAt,
    }),
    hasCoordinates: num(course?.latitude) != null && num(course?.longitude) != null,
  };
}

/**
 * Upsert the plan's inputs. Never writes quantities — those are derived.
 *
 * Throws on a write failure rather than returning quietly. An earlier version
 * discarded the error, so with migration 041 unapplied the UI cheerfully
 * reported "Weather updated" while nothing had been stored — the exact
 * failure mode that made migration 038 look like it had worked.
 */
export async function saveFbInputs(
  service: DB,
  tournamentId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data: existing } = await service.from('fb_calculations')
    .select('id').eq('tournament_id', tournamentId).maybeSingle();

  const body = { ...patch, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await service.from('fb_calculations').update(body).eq('id', existing.id as string)
    : await service.from('fb_calculations').insert({ tournament_id: tournamentId, ...body });

  if (error) {
    throw new Error(
      /column .* does not exist|schema cache/i.test(error.message)
        ? 'The F&B tables are missing columns — run db/migrations/041_fb_donations.sql.'
        : `Could not save the F&B plan: ${error.message}`,
    );
  }
}

/**
 * Fetch weather for the event and store it, geocoding the course first if we
 * have never done so. Returns null when the lookup genuinely failed — the
 * caller surfaces that rather than substituting a number.
 */
export async function refreshWeather(
  service: DB, tournamentId: string,
): Promise<{ weather: EventWeather | null; error?: string }> {
  const { data: t } = await service.from('tournaments')
    .select('event_date, shotgun_time, course_id, location_name')
    .eq('id', tournamentId).maybeSingle();
  if (!t?.event_date) return { weather: null, error: 'This tournament has no event date, so there is nothing to forecast.' };
  if (!t.course_id) return { weather: null, error: 'This tournament has no course attached, so there is no location to forecast for.' };

  const { data: course, error: courseErr } = await service.from('courses')
    .select('id, name, city, state, zip, latitude, longitude').eq('id', t.course_id).maybeSingle();
  // A missing *column* and a missing *row* are different problems and used to
  // produce the same misleading "check the course has a city and state".
  if (courseErr) {
    return {
      weather: null,
      error: /column .* does not exist|schema cache/i.test(courseErr.message)
        ? 'The courses table has no coordinates yet — run db/migrations/041_fb_donations.sql.'
        : `Could not read the course: ${courseErr.message}`,
    };
  }
  if (!course) return { weather: null, error: 'The course attached to this tournament no longer exists.' };

  let lat = num(course.latitude);
  let lng = num(course.longitude);

  if (lat == null || lng == null) {
    const point = await geocodeAddress({
      name: (course.name as string | null) ?? (t.location_name as string | null),
      city: course.city as string | null,
      state: course.state as string | null,
      zip: course.zip as string | null,
    });
    if (!point) {
      return {
        weather: null,
        error: `Could not place "${course.city ?? course.name ?? 'that course'}" on a map. Add a city and state to the course, or enter a temperature by hand.`,
      };
    }
    lat = point.latitude;
    lng = point.longitude;
    await service.from('courses').update({
      latitude: lat, longitude: lng,
      geocoded_at: new Date().toISOString(),
      geocode_label: point.label ?? null,
    }).eq('id', course.id as string);
  }

  const shotgunHour = parseShotgunTime(t.shotgun_time as string | null)?.hour ?? null;

  const weather = await getEventWeather(
    { latitude: lat, longitude: lng },
    t.event_date as string,
    { shotgunHour, roundHours: (18 * ASSUMED_MIN_PER_HOLE) / 60 },
  );
  if (!weather) {
    return { weather: null, error: 'The weather service did not answer. Try again in a moment, or enter a temperature by hand.' };
  }

  await saveFbInputs(service, tournamentId, {
    temperature_f: weather.temperatureF,
    precip_chance: weather.precipChance,
    weather_source: weather.source,
    weather_summary: weather.summary,
    weather_fetched_at: weather.fetchedAt,
  });

  return { weather };
}
