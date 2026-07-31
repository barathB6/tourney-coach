// One definition of "how many players", shared by the goals dashboard and the
// F&B calculator. These two must never disagree: if the dashboard says 72
// players and the kitchen orders for 68, someone goes hungry.
//
// A foursome is four bodies and a single is one. A sponsor-type registration
// is a package — signage and recognition — not people on the course, so it
// contributes nothing to headcount. Refunded entries stop counting the moment
// they are refunded, which is why this is derived on read and never stored.

export const PLAYERS_PER_REGISTRATION: Record<string, number> = {
  foursome: 4,
  single: 1,
  sponsor: 0,
};

export interface HeadcountRow {
  registration_type: string | null;
  payment_status: string | null;
}

export function countPlayers(rows: HeadcountRow[] | null | undefined): number {
  return (rows ?? [])
    .filter((r) => r.payment_status !== 'refunded')
    .reduce((n, r) => n + (PLAYERS_PER_REGISTRATION[r.registration_type ?? ''] ?? 0), 0);
}
