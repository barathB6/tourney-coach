// Public, documented job-board APIs. These are the same JSON endpoints the
// companies' own careers pages call, so no HTML scraping and nothing brittle.

import { getJSON, getText, stripHTML } from '../http.js';

export async function fetchGreenhouse(tokens, log) {
  const out = [];
  for (const token of tokens) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
    try {
      const json = await getJSON(url);
      if (!json) {
        log(`greenhouse: "${token}" not found (404) — prune it from config`);
        continue;
      }
      for (const j of json.jobs || []) {
        out.push({
          source: 'greenhouse',
          title: j.title,
          company: j.company_name || token,
          location: j.location?.name || '',
          url: j.absolute_url,
          description: stripHTML(j.content || '').slice(0, 6000),
          postedAt: j.updated_at || j.first_published || null,
        });
      }
    } catch (e) {
      log(`greenhouse: ${token} failed — ${e.message}`);
    }
  }
  log(`greenhouse: ${out.length} raw postings`);
  return out;
}

export async function fetchLever(tokens, log) {
  const out = [];
  for (const token of tokens) {
    const url = `https://api.lever.co/v0/postings/${token}?mode=json`;
    try {
      const json = await getJSON(url);
      if (!json) {
        log(`lever: "${token}" not found (404) — prune it from config`);
        continue;
      }
      for (const j of json) {
        out.push({
          source: 'lever',
          title: j.text,
          company: token,
          location: j.categories?.location || '',
          url: j.hostedUrl,
          description: stripHTML(j.descriptionPlain || j.description || '').slice(0, 6000),
          postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        });
      }
    } catch (e) {
      log(`lever: ${token} failed — ${e.message}`);
    }
  }
  log(`lever: ${out.length} raw postings`);
  return out;
}

export async function fetchAshby(tokens, log) {
  const out = [];
  for (const token of tokens) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`;
    try {
      const json = await getJSON(url);
      if (!json) {
        log(`ashby: "${token}" not found (404) — prune it from config`);
        continue;
      }
      for (const j of json.jobs || []) {
        out.push({
          source: 'ashby',
          title: j.title,
          company: json.name || token,
          location: j.location || '',
          url: j.jobUrl,
          description: stripHTML(j.descriptionHtml || j.descriptionPlain || '').slice(0, 6000),
          postedAt: j.publishedAt || null,
        });
      }
    } catch (e) {
      log(`ashby: ${token} failed — ${e.message}`);
    }
  }
  log(`ashby: ${out.length} raw postings`);
  return out;
}

export async function fetchSmartRecruiters(companies, log) {
  const out = [];
  for (const company of companies) {
    const url = `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100&q=intern`;
    try {
      const json = await getJSON(url);
      if (!json) {
        log(`smartrecruiters: "${company}" not found (404) — prune it from config`);
        continue;
      }
      for (const j of json.content || []) {
        out.push({
          source: 'smartrecruiters',
          title: j.name,
          company,
          location: [j.location?.city, j.location?.region, j.location?.country]
            .filter(Boolean)
            .join(', '),
          url: `https://jobs.smartrecruiters.com/${company}/${j.id}`,
          description: [j.name, j.department?.label, j.function?.label]
            .filter(Boolean)
            .join(' '),
          postedAt: j.releasedDate || null,
        });
      }
    } catch (e) {
      log(`smartrecruiters: ${company} failed — ${e.message}`);
    }
  }
  log(`smartrecruiters: ${out.length} raw postings`);
  return out;
}

// Community-maintained internship lists (SimplifyJobs et al). Despite living in
// a README, the tables are raw HTML: <tr><td>Company</td><td>Role</td>
// <td>Location</td><td><a href=apply></td><td>Age</td></tr>
const AGE_UNITS = { d: 1, w: 7, mo: 30, y: 365 };

function ageToISO(text) {
  const m = /^(\d+)\s*(d|w|mo|y)$/.exec(text.trim());
  if (!m) return null;
  const days = Number(m[1]) * AGE_UNITS[m[2]];
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function fetchGitHubLists(urls, log) {
  const out = [];
  for (const url of urls) {
    try {
      const html = await getText(url);
      let lastCompany = '';

      for (const [, row] of html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
        if (cells.length < 4) continue;

        // "↳" means "same company as the row above".
        let company = stripHTML(cells[0]);
        if (company === '↳' || company === '') company = lastCompany;
        else lastCompany = company;

        const title = stripHTML(cells[1]);
        const location = stripHTML(cells[2]);
        // First anchor in the apply cell is the employer's own posting; later
        // ones are the aggregator's tracking links.
        const link = /href="([^"]+)"/.exec(cells[3])?.[1];
        if (!title || !link) continue;
        if (/🔒|closed/i.test(cells[3])) continue;

        out.push({
          source: 'github-list',
          title,
          company,
          location,
          url: link.replace(/[?&]utm_source=[^&]*/g, '').replace(/[?&]ref=Simplify/g, ''),
          description: `${title} ${company} ${location}`,
          postedAt: cells[4] ? ageToISO(stripHTML(cells[4])) : null,
        });
      }
    } catch (e) {
      log(`github-list: ${url} failed — ${e.message}`);
    }
  }
  log(`github-list: ${out.length} raw postings`);
  return out;
}

export async function fetchUSAJobs(cfg, log) {
  const key = process.env.USAJOBS_API_KEY;
  const email = process.env.USAJOBS_EMAIL;
  if (!key || !email) {
    log('usajobs: enabled but USAJOBS_API_KEY / USAJOBS_EMAIL missing — skipped');
    return [];
  }
  const out = [];
  for (const keyword of cfg.keywords) {
    const url =
      'https://data.usajobs.gov/api/search?ResultsPerPage=100&Keyword=' +
      encodeURIComponent(keyword);
    try {
      const json = await getJSON(url, {
        headers: { 'Authorization-Key': key, 'User-Agent': email, Host: 'data.usajobs.gov' },
      });
      for (const item of json?.SearchResult?.SearchResultItems || []) {
        const d = item.MatchedObjectDescriptor;
        out.push({
          source: 'usajobs',
          title: d.PositionTitle,
          company: d.OrganizationName,
          location: (d.PositionLocation || []).map((l) => l.LocationName).join('; '),
          url: d.PositionURI,
          description: stripHTML(d.UserArea?.Details?.JobSummary || d.QualificationSummary || ''),
          postedAt: d.PublicationStartDate || null,
        });
      }
    } catch (e) {
      log(`usajobs: "${keyword}" failed — ${e.message}`);
    }
  }
  log(`usajobs: ${out.length} raw postings`);
  return out;
}
