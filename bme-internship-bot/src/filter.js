// Relevance scoring. A posting must look like (a) an internship / entry-level
// role AND (b) biomedical-adjacent work, or it gets dropped.

import crypto from 'node:crypto';

// Word-boundary matching, cached per phrase. Naive substring matching is wrong
// here: "intern" would match "internal"/"international", which is exactly how
// non-internship roles sneak past the intern gate.
const patternCache = new Map();

function patternFor(phrase) {
  let re = patternCache.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // \b doesn't fire next to punctuation like "co-op" or "510(k)", so use
    // explicit non-word-character lookarounds instead.
    re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g');
    patternCache.set(phrase, re);
  }
  re.lastIndex = 0;
  return re;
}

const countOccurrences = (haystack, needle) =>
  (haystack.match(patternFor(needle)) || []).length;

/** Weight matches in the title much more heavily than in the body blob. */
function tally(title, body, table) {
  let score = 0;
  const hits = [];
  for (const [phrase, weight] of Object.entries(table)) {
    const inTitle = countOccurrences(title, phrase) > 0;
    const inBody = countOccurrences(body, phrase);
    if (!inTitle && !inBody) continue;
    // Title match: full weight. Body: half weight, capped at 2 mentions.
    const contribution =
      (inTitle ? weight : 0) + (inBody ? (weight / 2) * Math.min(inBody, 2) : 0);
    score += contribution;
    hits.push(phrase);
  }
  return { score, hits };
}

export function scoreJob(job, scoring) {
  const title = (job.title || '').toLowerCase();
  const body = `${job.title || ''} ${job.description || ''} ${job.company || ''} ${
    job.location || ''
  }`.toLowerCase();

  for (const pattern of scoring.hardExcludeTitle) {
    if (new RegExp(`\\b${pattern}`, 'i').test(title)) {
      return { score: -99, reasons: [`title excluded: /${pattern}/`], keep: false };
    }
  }

  const intern = tally(title, body, scoring.internSignals);
  const domain = tally(title, body, scoring.domainSignals);
  const negative = tally(title, body, scoring.negativeSignals);

  // Both gates must fire — a "software intern" with no bio context is noise,
  // and so is a senior biomedical role.
  const keep = intern.score > 0 && domain.score > 0;

  return {
    score: Math.round((intern.score + domain.score + negative.score) * 10) / 10,
    internScore: intern.score,
    domainScore: domain.score,
    reasons: [...intern.hits, ...domain.hits, ...negative.hits.map((h) => `-${h}`)],
    keep,
  };
}

export function fingerprint(job) {
  const normalized = `${(job.company || '').toLowerCase().trim()}|${(job.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()}|${(job.url || '').split('?')[0]}`;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

export function applyFilters(jobs, config) {
  const cutoff = Date.now() - config.maxAgeDays * 86_400_000;
  const seen = new Set();
  const kept = [];

  for (const job of jobs) {
    if (!job?.title || !job?.url) continue;
    if (job.postedAt && new Date(job.postedAt).getTime() < cutoff) continue;

    const verdict = scoreJob(job, config.scoring);
    if (!verdict.keep || verdict.score < config.minScore) continue;

    const id = fingerprint(job);
    if (seen.has(id)) continue;
    seen.add(id);

    kept.push({ ...job, id, ...verdict });
  }

  return kept.sort((a, b) => b.score - a.score || (b.postedAt || '').localeCompare(a.postedAt || ''));
}
