// Pure contest logic — no I/O, no Supabase. Powers the Contest Hole Manager:
// leaderboard ranking per contest type, putting-pot economics, payout splits,
// and the distance conversions the UI reads/writes. Kept side-effect-free so it
// can be unit-tested directly (see scripts/verify-contests.ts).

export type ContestType = 'hole_in_one' | 'closest_to_pin' | 'long_drive' | 'putting';

export const CONTEST_META: Record<
  ContestType,
  { label: string; icon: string; blurb: string; betterDir: 'low' | 'high' | null; hasLeaderboard: boolean }
> = {
  hole_in_one: { label: 'Hole-in-One', icon: '⛳', blurb: 'Insured ace on a par 3.', betterDir: null, hasLeaderboard: false },
  closest_to_pin: { label: 'Closest to Pin', icon: '🎯', blurb: 'Nearest tee shot to the flag wins.', betterDir: 'low', hasLeaderboard: true },
  long_drive: { label: 'Longest Drive', icon: '💪', blurb: 'Longest drive in the fairway.', betterDir: 'high', hasLeaderboard: true },
  putting: { label: 'Putting Contest', icon: '🏌', blurb: 'Paid add-on with a pot payout.', betterDir: null, hasLeaderboard: false },
};

export const CONTEST_TYPES = Object.keys(CONTEST_META) as ContestType[];

export function isContestType(v: unknown): v is ContestType {
  return typeof v === 'string' && (CONTEST_TYPES as string[]).includes(v);
}

// ── Leaderboard ranking ──
// Standard competition ranking (1,1,3): equal measurements share a place, and
// the next distinct measurement skips accordingly. Entries with no measurement
// are dropped from the ranked list (they haven't posted yet).
export function rankEntries<T extends { value_inches: number | null }>(
  entries: T[],
  type: ContestType,
): (T & { rank: number })[] {
  const dir = CONTEST_META[type].betterDir;
  if (!dir) return [];
  const valid = entries.filter((e) => e.value_inches != null && Number.isFinite(e.value_inches));
  const sorted = [...valid].sort((a, b) =>
    dir === 'low' ? (a.value_inches as number) - (b.value_inches as number) : (b.value_inches as number) - (a.value_inches as number),
  );
  let rank = 0;
  let prev: number | null = null;
  return sorted.map((e, i) => {
    const v = e.value_inches as number;
    if (prev === null || v !== prev) { rank = i + 1; prev = v; }
    return { ...e, rank };
  });
}

// Long-drive can be split by category (gender/age). Returns groups in first-seen
// order, each internally ranked. 'open' collapses to a single group.
export function rankByCategory<T extends { value_inches: number | null; category?: string | null }>(
  entries: T[],
  type: ContestType,
  byCategory: boolean,
): { category: string; entries: (T & { rank: number })[] }[] {
  if (!byCategory) return [{ category: 'Overall', entries: rankEntries(entries, type) }];
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const e of entries) {
    const key = (e.category && e.category.trim()) || 'Uncategorized';
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key)!.push(e);
  }
  return order.map((category) => ({ category, entries: rankEntries(buckets.get(category)!, type) }));
}

// ── Putting economics ──
export function potCents(entryFeeCents: number | null | undefined, entrants: number | null | undefined): number {
  const fee = entryFeeCents ?? 0;
  const n = entrants ?? 0;
  return fee > 0 && n > 0 ? fee * n : 0;
}

// Parse a payout string like "60/30/10" or "50, 30, 20" into positive weights.
export function parseSplit(split: string | null | undefined): number[] {
  if (!split) return [];
  return split
    .split(/[^0-9.]+/)
    .map((s) => parseFloat(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// Distribute a pot across places by the split weights. Cents are floored per
// place and the leftover remainder is handed to the top places, so the parts
// always sum back to exactly the pot (no lost or invented pennies).
export function payoutBreakdown(
  pot: number,
  split: string | null | undefined,
): { place: number; pct: number; cents: number }[] {
  const parts = parseSplit(split);
  const total = parts.reduce((s, n) => s + n, 0);
  if (!parts.length || total <= 0 || pot <= 0) return [];
  const floored = parts.map((p) => Math.floor((p / total) * pot));
  let remainder = pot - floored.reduce((s, n) => s + n, 0);
  return parts.map((p, i) => {
    let cents = floored[i];
    if (remainder > 0) { cents += 1; remainder -= 1; }
    return { place: i + 1, pct: Math.round((p / total) * 100), cents };
  });
}

// ── Conversions & formatting ──
export const yardsToInches = (yards: number): number => yards * 36;
export const inchesToYards = (inches: number): number => inches / 36;

export function feetInchesToInches(feet: number, inches: number): number {
  return Math.max(0, Math.round(feet * 12 + inches));
}

export function formatFeetInches(totalInches: number | null | undefined): string {
  if (totalInches == null || !Number.isFinite(totalInches)) return '—';
  const whole = Math.max(0, Math.round(totalInches));
  const ft = Math.floor(whole / 12);
  const inch = whole % 12;
  if (ft === 0) return `${inch} in`;
  return inch === 0 ? `${ft} ft` : `${ft} ft ${inch} in`;
}

export function formatYards(totalInches: number | null | undefined): string {
  if (totalInches == null || !Number.isFinite(totalInches)) return '—';
  return `${Math.round(inchesToYards(totalInches))} yds`;
}

// Display a measurement the way its contest type expects.
export function formatMeasurement(totalInches: number | null | undefined, type: ContestType): string {
  if (type === 'long_drive') return formatYards(totalInches);
  return formatFeetInches(totalInches);
}

export function dollarsFromCents(cents: number | null | undefined): string {
  const c = cents ?? 0;
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

// ── Witness / completion helpers ──
export type Witness = { name: string; confirmed: boolean };

export function confirmedWitnessCount(witnesses: unknown): number {
  if (!Array.isArray(witnesses)) return 0;
  return witnesses.filter((w) => w && typeof w === 'object' && (w as Witness).confirmed).length;
}

// A contest is "decided" once it has a recorded winner (single-winner types) or
// at least one ranked payout winner (putting).
export function isDecided(contest: {
  contest_type: ContestType;
  winner_name?: string | null;
  winners?: unknown;
}): boolean {
  if (contest.contest_type === 'putting') return Array.isArray(contest.winners) && contest.winners.length > 0;
  return !!(contest.winner_name && String(contest.winner_name).trim());
}
