// Donor wall builder — the recognition list that goes on the sign, in the
// program, and on the microsite.
//
// This exists because recognition is the thing every donor was actually
// promised on the phone, and it is the thing that most often gets forgotten in
// the week before the event. Building it from the committed prospects means
// nobody who said yes can be left off by accident.
//
// Two rules baked in:
//   - Only committed donors appear. A vendor who is still "pending" on a sign
//     that goes to print is an embarrassment in both directions.
//   - Ordering is by contribution size where known, then alphabetical. It is
//     never by when they were added, which is the accidental default and reads
//     as arbitrary to anyone looking at the sign.

import { VENDOR_CATEGORIES, categoryMeta } from '@/lib/donations/vendors';

export interface DonorInput {
  company: string | null;
  category: string | null;
  status: string;
  committedValueCents: number | null;
  askSummary: string | null;
}

export interface DonorWallGroup {
  key: string;
  label: string;
  emoji: string;
  donors: { name: string; detail: string | null }[];
}

export interface DonorWall {
  groups: DonorWallGroup[];
  total: number;
  /** Flat list for a single-line credit, e.g. under a photo. */
  inline: string;
  /** Plain text for a program or a sign. */
  plainText: string;
  /** Vendors who committed but have no category — they'd be silently dropped. */
  uncategorised: string[];
}

export function buildDonorWall(
  donors: DonorInput[],
  opts: { tournamentName?: string | null; heading?: string } = {},
): DonorWall {
  const committed = donors.filter((d) => d.status === 'committed' && (d.company ?? '').trim());

  const groups: DonorWallGroup[] = [];
  for (const cat of VENDOR_CATEGORIES) {
    const inCat = committed
      .filter((d) => d.category === cat.key)
      .sort((a, b) => {
        const av = a.committedValueCents ?? -1;
        const bv = b.committedValueCents ?? -1;
        if (av !== bv) return bv - av;
        return (a.company ?? '').localeCompare(b.company ?? '');
      });
    if (!inCat.length) continue;
    groups.push({
      key: cat.key,
      label: cat.label,
      emoji: cat.emoji,
      // The detail line is what they gave, never what it was worth — a sign
      // that prints "$480" turns a thank-you into a price list.
      donors: inCat.map((d) => ({ name: (d.company ?? '').trim(), detail: d.askSummary })),
    });
  }

  const uncategorised = committed
    .filter((d) => !d.category || !categoryMeta(d.category))
    .map((d) => (d.company ?? '').trim());
  if (uncategorised.length) {
    groups.push({
      key: 'other', label: 'With thanks also to', emoji: '\u{1F91D}',
      donors: uncategorised.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, detail: null })),
    });
  }

  const names = groups.flatMap((g) => g.donors.map((d) => d.name));
  const heading = opts.heading
    ?? `${opts.tournamentName ? `${opts.tournamentName} ` : ''}thanks our donors`;

  const plainText = [
    heading.toUpperCase(),
    '',
    ...groups.flatMap((g) => [
      g.label,
      ...g.donors.map((d) => `    ${d.name}${d.detail ? ` — ${d.detail}` : ''}`),
      '',
    ]),
  ].join('\n').trimEnd();

  return {
    groups,
    total: names.length,
    inline: names.length
      ? `With thanks to ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' and ' : ''}${names[names.length - 1]}.`
      : '',
    plainText: names.length ? plainText : '',
    uncategorised,
  };
}
