// Turns a list of company names into live job-board tokens.
//
// Board slugs are unguessable one at a time but highly patterned in aggregate
// ("Boston Scientific" -> bostonscientific / boston-scientific / bostonsci).
// This tries the common variants against each provider and keeps what answers
// with actual postings, so config.json is generated rather than hand-guessed.

import { getJSON } from './http.js';

function variants(name) {
  const clean = name
    .toLowerCase()
    .replace(/[.,']/g, '')
    .replace(/\s*&\s*/g, ' and ')
    .trim();
  const words = clean.split(/\s+/);
  const set = new Set([
    words.join(''),
    words.join('-'),
    words[0],
    // Drop common corporate suffixes: "Vertex Pharmaceuticals" -> "vertex"
    words.filter((w) => !/^(inc|corp|corporation|company|group|holdings|systems|technologies|labs|laboratories|pharmaceuticals|therapeutics|biosciences|bioscience|sciences|medical|health|care)$/.test(w)).join(''),
  ]);
  set.delete('');
  return [...set];
}

const PROVIDERS = [
  {
    name: 'greenhouse',
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    count: (j) => j?.jobs?.length ?? 0,
  },
  {
    name: 'lever',
    url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    count: (j) => (Array.isArray(j) ? j.length : 0),
  },
  {
    name: 'ashby',
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    count: (j) => j?.jobs?.length ?? 0,
  },
  {
    name: 'smartrecruiters',
    // This one answers 200 with an empty page for unknown companies, so the
    // posting count — not the status code — is what proves a board exists.
    url: (t) => `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=1`,
    count: (j) => j?.totalFound ?? 0,
  },
];

export async function discover(names, log) {
  const found = { greenhouse: [], lever: [], ashby: [], smartrecruiters: [] };
  let checked = 0;

  for (const name of names) {
    let hit = null;
    for (const token of variants(name)) {
      for (const provider of PROVIDERS) {
        checked++;
        try {
          const json = await getJSON(provider.url(token));
          const n = provider.count(json);
          if (n > 0) {
            hit = { provider: provider.name, token, n };
            break;
          }
        } catch {
          // 4xx/timeout just means "not this slug" — keep trying.
        }
      }
      if (hit) break;
    }

    if (hit) {
      found[hit.provider].push(hit.token);
      log(`found  ${name.padEnd(28)} ${hit.provider}/${hit.token}  (${hit.n} postings)`);
    } else {
      log(`  --   ${name.padEnd(28)} no public board found`);
    }
  }

  log(`${checked} probes, ${Object.values(found).flat().length}/${names.length} companies resolved`);
  return found;
}
