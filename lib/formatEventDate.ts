// Formatting an event date without moving it a day.
//
// `tournaments.event_date` is a DATE — "2026-10-10", no time, no zone. Passing
// that straight to `new Date()` parses it as UTC midnight, and
// toLocaleDateString then renders it in the server's local zone. Anywhere west
// of UTC that prints "October 9".
//
// This was live in three outward-facing emails — the registration receipt, the
// sponsor confirmation, and the sponsor outreach draft — so sponsors and
// players were being told the tournament was the day before it is. Anchoring
// at midday makes the calendar date survive any real-world offset.

export function formatEventDate(
  date: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
): string {
  if (!date) return 'TBD';
  // Already carries a time (and therefore a real instant)? Leave it alone.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'TBD';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

/**
 * Format a schedule instant as the wall-clock time at the course.
 *
 * Event schedules in this app are *wall clock*, not absolute instants. A
 * shotgun at "8:30 AM" means half past eight where the course is, whatever
 * zone the server, the organizer's laptop and the kitchen's phone are in. We
 * carry that by building the instant with a Z suffix — 08:30 local becomes
 * 08:30Z — which only reads back correctly if it is also *formatted* in UTC.
 *
 * Formatting these with the runtime's local zone (the default) renders an 8am
 * shotgun as 4am on a US-East server and 1am on a US-West one, on a sheet the
 * kitchen works from. Always go through this.
 */
export function formatEventTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
}
