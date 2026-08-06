// Pluralisation, in one place.
//
// This started life inside the F&B calculator because a kitchen sheet reading
// "9 boxs" is the kind of detail that makes an organizer trust nothing else on
// the page. The same problem is everywhere — "1 confirmed sponsors",
// "1 volunteers", "1 registrations" — so it lives here now, and the calculator
// re-exports it.
//
// Deliberately not a full inflection library: the words this app pluralises are
// its own vocabulary (sponsor, player, foursome, box, case, role), and the
// sibilant rule covers every one of them.

export function plural(word: string, n: number): string {
  if (n === 1) return word;
  return /(s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

/** "1 sponsor" / "3 sponsors" — the count and its noun, agreeing. */
export function countOf(n: number, word: string): string {
  return `${n} ${plural(word, n)}`;
}
