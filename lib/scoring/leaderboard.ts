// Day 21 leaderboard engine — PURE functions (no database, no Supabase
// import), same pattern as lib/gps/aggregateCore: the DB glue lives in the
// API routes, and scripts/verify-leaderboard.ts drives this offline against
// synthetic tournaments.
//
// Scoring model: one score row per TEAM (registration = the foursome unit)
// per hole — exactly how scramble is scored, and how best-ball/stroke-play
// scorekeepers record the counted number per hole in charity events. A team
// resubmitting a hole overwrites nothing: rows are append-only and the
// LATEST submission wins (late submissions and corrections both ride this).

export type TournamentFormat = 'scramble' | 'best_ball' | 'alternate_shot' | 'stroke_play';
export type MaxScoreRule = 'par' | 'double_bogey' | 'none';

export interface ScoreRow {
  registrationId: string;
  holeNumber: number;
  strokes: number;
  submittedAt: string; // ISO — latest per (registration, hole) wins
}

export interface TeamInfo {
  registrationId: string;
  teamName: string | null;
  contactName: string;
  foursomeNumber: number | null;
}

export interface HoleInfo {
  holeNumber: number;
  par: number | null;
}

export interface StandingRow {
  rank: number;               // 1-based; ties share the lowest rank (T2, T2, 4)
  tied: boolean;
  registrationId: string;
  teamName: string;           // display name (team_name ?? contact_name)
  foursomeNumber: number | null;
  holesCompleted: number;     // "thru"
  totalStrokes: number;
  toPar: number | null;       // null when any completed hole has no par set
  holeScores: Record<number, number>; // latest score per hole
  // Pace of play relative to the leading group's progress (holes through):
  // green = with the field, yellow = a couple holes back, red = well behind.
  // null until a team has started.
  pace: 'green' | 'yellow' | 'red' | null;
}

// Pace status from how many holes a team is behind the front of the field.
// Field-relative (needs no per-team start clock): green ≤1 back, yellow 2–3,
// red ≥4. A team that hasn't teed off yet has no pace.
export function paceStatus(holesCompleted: number, fieldMaxThru: number): 'green' | 'yellow' | 'red' | null {
  if (holesCompleted <= 0) return null;
  const behind = fieldMaxThru - holesCompleted;
  return behind <= 1 ? 'green' : behind <= 3 ? 'yellow' : 'red';
}

// ── Max score rule ──────────────────────────────────────────────────────────
// "Pick up at par" (or double bogey): the cap a team is allowed to record on
// a hole under the event's pace-of-play rule. Returns null when uncapped or
// when par is unknown (no cap can be computed without par).
export function maxScoreCap(rule: MaxScoreRule, par: number | null): number | null {
  if (rule === 'none' || par == null) return null;
  return rule === 'par' ? par : par + 2;
}

// Clamp an entered score to the rule's cap. `capped` tells the UI to show
// the friendly pick-up message instead of silently rewriting the number.
export function applyMaxScore(rule: MaxScoreRule, par: number | null, strokes: number): { strokes: number; capped: boolean } {
  const cap = maxScoreCap(rule, par);
  if (cap == null || strokes <= cap) return { strokes, capped: false };
  return { strokes: cap, capped: true };
}

// ── Latest-wins reduction ───────────────────────────────────────────────────
export function latestScores(rows: ScoreRow[]): Map<string, Map<number, ScoreRow>> {
  const byTeam = new Map<string, Map<number, ScoreRow>>();
  for (const row of rows) {
    if (!byTeam.has(row.registrationId)) byTeam.set(row.registrationId, new Map());
    const holes = byTeam.get(row.registrationId)!;
    const existing = holes.get(row.holeNumber);
    // Latest submission wins. A valid timestamp always beats an unparseable
    // stored one, so a newer real score can't be blocked by malformed data.
    const rt = Date.parse(row.submittedAt);
    const et = existing ? Date.parse(existing.submittedAt) : NaN;
    if (!existing || Number.isNaN(et) || (!Number.isNaN(rt) && rt >= et)) {
      holes.set(row.holeNumber, row);
    }
  }
  return byTeam;
}

// ── Recent-form trend ───────────────────────────────────────────────────────
// A real, honestly-derivable momentum signal for the TV board: strokes-to-par
// over a team's N MOST RECENTLY SUBMITTED holes. Negative = playing hot
// (under par lately) → an "up" trend; positive = cooling off. Requires pars
// on the sampled holes; returns null when it can't be computed (no pars / no
// scores) so the UI can show a neutral dash rather than invent a number.
export interface Trend { toPar: number; holes: number; direction: 'up' | 'down' | 'flat' }

// Given ONE team's latest-per-hole rows, compute the trend over its n most
// recent holes (by submission time). Callers must reduce to latest-per-hole
// first (e.g. via latestScores) so a corrected hole isn't double-counted.
export function recentFormFromHoleRows(teamRows: ScoreRow[], pars: Map<number, number>, n = 3): Trend | null {
  const withPar = teamRows.filter((r) => pars.has(r.holeNumber));
  if (withPar.length === 0) return null;
  const ts = (r: ScoreRow) => { const t = Date.parse(r.submittedAt); return Number.isNaN(t) ? 0 : t; };
  const recent = [...withPar].sort((a, b) => ts(b) - ts(a)).slice(0, n);
  const toPar = recent.reduce((sum, r) => sum + (r.strokes - pars.get(r.holeNumber)!), 0);
  return { toPar, holes: recent.length, direction: toPar < 0 ? 'up' : toPar > 0 ? 'down' : 'flat' };
}

// ── Tie-breaking: USGA-recommended scorecard countback ─────────────────────
// Industry standard for events that can't play extra holes: compare the last
// nine, then last six, last three, then the final hole, by strokes relative
// to par over those holes, in card order. Segments are derived from the
// event's actual holes, so a 9-hole event breaks ties on its last 6/3/1
// rather than the (unplayed) 10–18. Countback is by HOLE NUMBER regardless of
// shotgun starting hole, per the USGA recommendation.
//
// IMPORTANT: only applied between teams who have FINISHED the round (see
// computeStandings). Card-order countback across teams who have completed
// DIFFERENT segments is not a consistent ordering, so mid-round ties are left
// tied — standings among teams still playing are provisional by nature.
export function countbackSegments(holeNumbers: number[]): number[][] {
  const holes = [...new Set(holeNumbers)].sort((a, b) => a - b);
  const suffix = (n: number) => (holes.length >= n ? holes.slice(holes.length - n) : holes.slice());
  const raw = [suffix(9), suffix(6), suffix(3), suffix(1)];
  // Drop segments that don't actually narrow (e.g. "last 9" of a 9-hole card
  // equals the whole card), keeping the nested progression unique.
  const seen = new Set<string>();
  const segments: number[][] = [];
  for (const seg of raw) {
    const key = seg.join(',');
    if (seg.length && !seen.has(key)) { seen.add(key); segments.push(seg); }
  }
  return segments;
}

function segmentToPar(holeScores: Record<number, number>, pars: Map<number, number>, segment: number[]): number | null {
  let total = 0;
  for (const h of segment) {
    const s = holeScores[h];
    const p = pars.get(h);
    if (s == null || p == null) return null; // segment not fully played/par'd
    total += s - p;
  }
  return total;
}

// Returns <0 when a ranks ahead of b via countback, >0 when b ranks ahead,
// 0 when indistinguishable (true tie). Segments default to a full 18-hole
// card when not supplied (keeps the standalone/unit call site simple).
export function countbackCompare(
  a: { holeScores: Record<number, number> },
  b: { holeScores: Record<number, number> },
  pars: Map<number, number>,
  segments: number[][] = countbackSegments([...pars.keys()]),
): number {
  for (const segment of segments) {
    const sa = segmentToPar(a.holeScores, pars, segment);
    const sb = segmentToPar(b.holeScores, pars, segment);
    if (sa == null || sb == null) continue; // can't compare this segment
    if (sa !== sb) return sa - sb;
  }
  return 0;
}

// ── Standings ───────────────────────────────────────────────────────────────
// All four formats reduce to the same team-per-hole arithmetic at the
// leaderboard level (the format changes how the number was PLAYED, not how
// standings are computed from it): rank by strokes-to-par over completed
// holes; a team that has played more holes at the same to-par is NOT ahead —
// to-par is the fair mid-round comparison across shotgun start positions.
// Stroke-play events with no pars entered fall back to total strokes.
export function computeStandings(params: {
  format: TournamentFormat;   // recorded for display; arithmetic is shared
  maxScoreRule: MaxScoreRule; // caps were applied at submission; not re-applied here
  teams: TeamInfo[];
  holes: HoleInfo[];
  scores: ScoreRow[];
}): StandingRow[] {
  const pars = new Map<number, number>();
  for (const h of params.holes) if (h.par != null) pars.set(h.holeNumber, h.par);
  // Event-wide (NOT per-team) decision: rank by to-par when the event has any
  // pars at all, else by total strokes. Deciding per team would compare a
  // to-par integer against a raw stroke count — a birdying team could sort
  // below a +6 team. to-par sums only over completed holes that HAVE a par.
  const hasAnyPar = pars.size > 0;
  const finishedCount = new Set(params.holes.map((h) => h.holeNumber)).size;
  const segments = countbackSegments([...pars.keys()]);

  const byTeam = latestScores(params.scores);

  const rows = params.teams.map((team) => {
    const holeMap = byTeam.get(team.registrationId) ?? new Map<number, ScoreRow>();
    const holeScores: Record<number, number> = {};
    let totalStrokes = 0;
    let toParKnown = 0; // over completed holes with a known par
    for (const [hole, row] of holeMap) {
      holeScores[hole] = row.strokes;
      totalStrokes += row.strokes;
      const par = pars.get(hole);
      if (par != null) toParKnown += row.strokes - par;
    }
    return {
      registrationId: team.registrationId,
      teamName: team.teamName?.trim() || team.contactName,
      foursomeNumber: team.foursomeNumber,
      holesCompleted: holeMap.size,
      totalStrokes,
      toPar: hasAnyPar ? toParKnown : null,
      holeScores,
    };
  });

  // Teams with no scores yet sort to the bottom, alphabetically.
  const started = rows.filter((r) => r.holesCompleted > 0);
  const waiting = rows.filter((r) => r.holesCompleted === 0).sort((a, b) => a.teamName.localeCompare(b.teamName));

  const primary = (r: typeof rows[number]) => (hasAnyPar ? r.toPar! : r.totalStrokes);
  // Countback only orders teams who have BOTH finished the round — mid-round
  // it is not a consistent total order (different teams, different segments),
  // so unfinished ties stay tied rather than getting contradictory ranks.
  const tieBreak = (a: typeof rows[number], b: typeof rows[number]) =>
    (finishedCount > 0 && a.holesCompleted === finishedCount && b.holesCompleted === finishedCount)
      ? countbackCompare(a, b, pars, segments)
      : 0;

  started.sort((a, b) => {
    const pa = primary(a), pb = primary(b);
    if (pa !== pb) return pa - pb;
    const cb = tieBreak(a, b);
    if (cb !== 0) return cb;
    return a.teamName.localeCompare(b.teamName); // stable display order for true ties
  });

  // Pace is measured against the front of the field (most holes through).
  const fieldMaxThru = started.reduce((m, r) => Math.max(m, r.holesCompleted), 0);

  // Assign ranks: countback breaks the rank; identical primary AND no
  // countback separation means a shared (T) rank.
  const standings: StandingRow[] = [];
  for (let i = 0; i < started.length; i++) {
    const r = started[i];
    let rank = i + 1;
    let tied = false;
    if (i > 0) {
      const prev = started[i - 1];
      const samePrimary = primary(prev) === primary(r);
      if (samePrimary && tieBreak(prev, r) === 0) {
        rank = standings[i - 1].rank;
        tied = true;
        standings[i - 1].tied = true;
      }
    }
    standings.push({ rank, tied, ...r, pace: paceStatus(r.holesCompleted, fieldMaxThru) });
  }
  let nextRank = started.length + 1;
  for (const w of waiting) {
    standings.push({ rank: nextRank++, tied: false, ...w, pace: null });
  }
  return standings;
}
