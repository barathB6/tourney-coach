// Weather for a tournament date and course location, via Open-Meteo.
//
// Open-Meteo was chosen over the usual suspects because it needs no API key
// and no account: a self-hosted TourneyCoach works out of the box, and there
// is no secret to leak. Attribution and terms: https://open-meteo.com/
//
// Two regimes, and telling them apart is the whole point of `source`:
//
//   ≤ 16 days out   → a real forecast for that date.
//   > 16 days out   → climate normals: the same calendar date averaged over
//                     the past five years at that location. This is what
//                     "time of year" means as a calculator input. It is NOT a
//                     forecast and the UI must never present it as one.
//
// Nothing here ever invents a temperature. Every failure path returns null so
// the organizer is asked to type one in.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/** Open-Meteo publishes 16 days of forecast. */
export const FORECAST_HORIZON_DAYS = 16;
/** Years of history averaged for climate normals. */
export const NORMALS_YEARS = 5;
/** Days either side of the target date included in the normals window. */
export const NORMALS_WINDOW_DAYS = 3;

export type WeatherSource = 'forecast' | 'normals' | 'manual';

export interface EventWeather {
  temperatureF: number;
  precipChance: number | null;
  source: WeatherSource;
  summary: string;
  fetchedAt: string;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
  label?: string | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

async function getJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // network down, rate limited, aborted — all mean "ask the organizer"
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a postal address to a point. Returns null rather than guessing. */
export async function geocodeAddress(parts: {
  name?: string | null; city?: string | null; state?: string | null; zip?: string | null;
}): Promise<GeoPoint | null> {
  // Open-Meteo's geocoder is a place-name index, not a street-address
  // geocoder, so we search the locality. For weather that is plenty — the
  // temperature does not change measurably across a town.
  const query = [parts.city, parts.state].filter(Boolean).join(', ')
    || parts.zip || parts.name;
  if (!query) return null;

  const data = await getJson(`${GEOCODE_URL}?name=${encodeURIComponent(String(query))}&count=1&language=en&format=json`);
  const hit = (data as { results?: unknown[] } | null)?.results?.[0] as
    { latitude?: unknown; longitude?: unknown; name?: unknown; admin1?: unknown } | undefined;
  if (!hit || !isNum(hit.latitude) || !isNum(hit.longitude)) return null;

  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    label: [hit.name, hit.admin1].filter(Boolean).join(', ') || null,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

function daysUntil(dateISO: string, now = new Date()): number {
  const target = Date.parse(`${dateISO.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(target)) return NaN;
  return Math.floor((target - now.getTime()) / 86_400_000);
}

/**
 * Average an hourly series across the hours a round is actually played.
 *
 * This matters more than it looks: a daily high of 88°F recorded at 4pm is not
 * what a field that tees off at 8am and finishes at 1pm experiences. Falls back
 * to the caller's daily value when the window can't be resolved.
 */
function averageOverPlayWindow(
  times: string[], values: (number | null)[], startHour: number, endHour: number,
): number | null {
  const picked: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const hour = Number(times[i]?.slice(11, 13));
    const v = values[i];
    if (!Number.isFinite(hour) || !isNum(v)) continue;
    if (hour >= startHour && hour <= endHour) picked.push(v);
  }
  if (!picked.length) return null;
  return picked.reduce((a, b) => a + b, 0) / picked.length;
}

/**
 * Weather for the event. `shotgunHour` (0–23, local) narrows the reading to the
 * hours actually on the course; omit it and we use the daily figures.
 */
export async function getEventWeather(
  point: GeoPoint,
  eventDate: string,
  opts: { shotgunHour?: number | null; roundHours?: number } = {},
): Promise<EventWeather | null> {
  const date = eventDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const out = daysUntil(date);
  if (Number.isNaN(out)) return null;

  const startHour = isNum(opts.shotgunHour) ? Math.min(23, Math.max(0, Math.round(opts.shotgunHour))) : null;
  const endHour = startHour == null ? null
    : Math.min(23, startHour + Math.ceil(opts.roundHours ?? 5));

  // ── Within forecast range ────────────────────────────────────────────────
  if (out >= 0 && out <= FORECAST_HORIZON_DAYS) {
    const url = `${FORECAST_URL}?latitude=${point.latitude}&longitude=${point.longitude}`
      + `&daily=apparent_temperature_max,temperature_2m_max,precipitation_probability_max`
      + `&hourly=apparent_temperature,precipitation_probability`
      + `&temperature_unit=fahrenheit&timezone=auto&start_date=${date}&end_date=${date}`;
    const data = await getJson(url) as {
      daily?: { apparent_temperature_max?: (number | null)[]; temperature_2m_max?: (number | null)[]; precipitation_probability_max?: (number | null)[] };
      hourly?: { time?: string[]; apparent_temperature?: (number | null)[]; precipitation_probability?: (number | null)[] };
    } | null;
    if (!data?.daily) return null;

    const dailyTemp = data.daily.apparent_temperature_max?.[0] ?? data.daily.temperature_2m_max?.[0] ?? null;
    const dailyPrecip = data.daily.precipitation_probability_max?.[0] ?? null;

    let temp = isNum(dailyTemp) ? dailyTemp : null;
    let precip = isNum(dailyPrecip) ? dailyPrecip : null;
    let windowed = false;

    if (startHour != null && endHour != null && data.hourly?.time) {
      const t = averageOverPlayWindow(data.hourly.time, data.hourly.apparent_temperature ?? [], startHour, endHour);
      const p = averageOverPlayWindow(data.hourly.time, data.hourly.precipitation_probability ?? [], startHour, endHour);
      if (t != null) { temp = t; windowed = true; }
      if (p != null) precip = p;
    }
    if (temp == null) return null;

    return {
      temperatureF: Math.round(temp * 10) / 10,
      precipChance: precip == null ? null : Math.round(precip),
      source: 'forecast',
      summary: windowed
        ? `Forecast ${Math.round(temp)}°F feels-like, averaged over the hours you're on the course${precip != null ? `, ${Math.round(precip)}% chance of rain` : ''}.`
        : `Forecast high ${Math.round(temp)}°F feels-like${precip != null ? `, ${Math.round(precip)}% chance of rain` : ''}.`,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ── Beyond forecast range: climate normals ───────────────────────────────
  // Same calendar date in each of the past NORMALS_YEARS, ±NORMALS_WINDOW_DAYS,
  // averaged. Past events get this too — the archive is the record of what
  // actually happened.
  const year = Number(date.slice(0, 4));
  const month = date.slice(5, 7);
  const day = date.slice(8, 10);
  const thisYear = new Date().getUTCFullYear();
  const lastComplete = out < 0 ? year : thisYear - 1;

  const temps: number[] = [];
  const precips: number[] = [];

  for (let i = 0; i < NORMALS_YEARS; i++) {
    const y = lastComplete - i;
    const centre = Date.parse(`${y}-${month}-${day}T12:00:00Z`);
    if (Number.isNaN(centre)) continue; // Feb 29 in a non-leap year
    const from = ymd(new Date(centre - NORMALS_WINDOW_DAYS * 86_400_000));
    const to = ymd(new Date(centre + NORMALS_WINDOW_DAYS * 86_400_000));

    const url = `${ARCHIVE_URL}?latitude=${point.latitude}&longitude=${point.longitude}`
      + `&start_date=${from}&end_date=${to}`
      + `&daily=apparent_temperature_max,temperature_2m_max,precipitation_sum&temperature_unit=fahrenheit&timezone=auto`;
    const data = await getJson(url) as {
      daily?: { apparent_temperature_max?: (number | null)[]; temperature_2m_max?: (number | null)[]; precipitation_sum?: (number | null)[] };
    } | null;
    if (!data?.daily) continue;

    const series = data.daily.apparent_temperature_max ?? data.daily.temperature_2m_max ?? [];
    for (const v of series) if (isNum(v)) temps.push(v);
    // The archive has no "chance of rain" — it records what fell. The share of
    // days in the window with measurable rain IS the historical probability.
    for (const v of data.daily.precipitation_sum ?? []) if (isNum(v)) precips.push(v > 0.1 ? 100 : 0);
  }

  if (!temps.length) return null;
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
  const wetShare = precips.length ? precips.reduce((a, b) => a + b, 0) / precips.length : null;

  return {
    temperatureF: Math.round(avg * 10) / 10,
    precipChance: wetShare == null ? null : Math.round(wetShare),
    source: 'normals',
    summary: `Typical for this date: ${Math.round(avg)}°F, averaged over the last ${NORMALS_YEARS} years`
      + `${wetShare != null ? `, with rain on ${Math.round(wetShare)}% of them` : ''}. Not a forecast — the date is more than ${FORECAST_HORIZON_DAYS} days out.`,
    fetchedAt: new Date().toISOString(),
  };
}
