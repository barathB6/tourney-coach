// Shotgun time parsing, in one place.
//
// `tournaments.shotgun_time` is free text — real rows hold "8:30 AM", not
// "08:30". A strict HH:MM parser silently rejects those and falls back to 8:00,
// which has now been the same bug twice in two different code paths (the F&B
// kitchen timeline, and anchorFor in lib/toc/phase.ts, which would have fired
// every day-of reminder 30 minutes early). It lives here so nothing has to
// reach into lib/fb/plan.ts — and so validation on the tournament create route
// can use it without pulling in a Supabase client.

export interface ShotgunClock { hour: number; minute: number }

export function parseShotgunTime(raw: string | null | undefined): ShotgunClock | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

// Canonical storage form: "8:30 AM". Everything that reads shotgun_time goes
// through parseShotgunTime, and everything that shows it to a human shows the
// stored string — so the stored string should be the one a human would write.
// An <input type="time"> hands over "08:30"; this is what turns it into that.
export function formatShotgunTime(raw: string | null | undefined): string | null {
  const t = parseShotgunTime(raw);
  if (!t) return null;
  const meridiem = t.hour < 12 ? 'AM' : 'PM';
  const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${hour12}:${String(t.minute).padStart(2, '0')} ${meridiem}`;
}
