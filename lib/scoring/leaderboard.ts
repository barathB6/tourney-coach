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
    if (!existing || Date.parse(row.submittedAt) >= Date.parse(existing.submittedAt)) {
      holes.set(row.holeNumber, row);
    }
  }
  return byTeam;
}

// ── Tie-breaking: USGA-recommended scorecard countback ─────────────────────
// Industry standard for events that can't play extra holes: compare the last
// nine (holes 10–18), then last six (13–18), last three (16–18), then the
// 18th, by strokes relative to par over those holes. Countback is by HOLE
// NUMBER (card order) regardless of shotgun starting hole, per the USGA
// recommendation. Teams tied through every stage share the rank.
//
// Countback only differentiates teams that completed the compared segment;
// mid-round ties (different holes completed) stay tied on the leaderboard —
// standings among teams mid-play are provisional by nature.
const COUNTBACK_SEGMENTS: number[][] = [
  [10, 11, 12, 13, 14, 15, 16, 17, 18],
  [13, 14, 15, 16, 17, 18],
  [16, 17, 18],
  [18],
];

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
// 0 when indistinguishable (true tie).
export function countbackCompare(
  a: { holeScores: Record<number, number> },
  b: { holeScores: Record<number, number> },
  pars: Map<number, number>,
): number {
  for (const segment of COUNTBACK_SEGMENTS) {
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

  const byTeam = latestScores(params.scores);

  const rows = params.teams.map((team) => {
    const holeMap = byTeam.get(team.registrationId) ?? new Map<number, ScoreRow>();
    const holeScores: Record<number, number> = {};
    let totalStrokes = 0;
    let toPar: number | null = 0;
    for (const [hole, row] of holeMap) {
      holeScores[hole] = row.strokes;
      totalStrokes += row.strokes;
      const par = pars.get(hole);
      if (toPar != null) toPar = par == null ? null : toPar + (row.strokes - par);
    }
    return {
      registrationId: team.registrationId,
      teamName: team.teamName?.trim() || team.contactName,
      foursomeNumber: team.foursomeNumber,
      holesCompleted: holeMap.size,
      totalStrokes,
      toPar,
      holeScores,
    };
  });

  // Teams with no scores yet sort to the bottom, alphabetically.
  const started = rows.filter((r) => r.holesCompleted > 0);
  const waiting = rows.filter((r) => r.holesCompleted === 0).sort((a, b) => a.teamName.localeCompare(b.teamName));

  const primary = (r: typeof rows[number]) => (r.toPar != null ? r.toPar : r.totalStrokes);
  started.sort((a, b) => {
    const pa = primary(a), pb = primary(b);
    if (pa !== pb) return pa - pb;
    const cb = countbackCompare(a, b, pars);
    if (cb !== 0) return cb;
    return a.teamName.localeCompare(b.teamName); // stable display order for true ties
  });

  // Assign ranks: countback breaks the rank; identical primary AND countback
  // 0 means a shared (T) rank.
  const standings: StandingRow[] = [];
  for (let i = 0; i < started.length; i++) {
    const r = started[i];
    let rank = i + 1;
    let tied = false;
    if (i > 0) {
      const prev = started[i - 1];
      const samePrimary = primary(prev) === primary(r);
      if (samePrimary && countbackCompare(prev, r, pars) === 0) {
        rank = standings[i - 1].rank;
        tied = true;
        standings[i - 1].tied = true;
      }
    }
    standings.push({ rank, tied, ...r });
  }
  let nextRank = started.length + 1;
  for (const w of waiting) {
    standings.push({ rank: nextRank++, tied: false, ...w });
  }
  return standings;
}
