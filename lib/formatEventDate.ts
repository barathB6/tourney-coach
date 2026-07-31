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
