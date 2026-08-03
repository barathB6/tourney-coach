// Reddit via the official JSON API. Uses OAuth (script app) when
// REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are set — strongly recommended, since
// the anonymous www.reddit.com endpoints are aggressively rate-limited.

import { getJSON, postForm } from '../http.js';

let token = null;

async function auth() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token) return token;

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const body = process.env.REDDIT_USERNAME
    ? {
        grant_type: 'password',
        username: process.env.REDDIT_USERNAME,
        password: process.env.REDDIT_PASSWORD,
      }
    : { grant_type: 'client_credentials' };

  const json = await postForm('https://www.reddit.com/api/v1/access_token', body, {
    Authorization: `Basic ${basic}`,
  });
  token = json.access_token;
  return token;
}

function base(tok) {
  return tok ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
}

function headers(tok) {
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

function normalize(child, subreddit) {
  const d = child.data;
  if (!d || d.stickied) return null;
  return {
    source: `reddit/r/${subreddit}`,
    title: d.title,
    company: d.link_flair_text || `r/${subreddit}`,
    location: '',
    url: `https://www.reddit.com${d.permalink}`,
    description: (d.selftext || '').slice(0, 4000),
    postedAt: new Date(d.created_utc * 1000).toISOString(),
    author: d.author,
  };
}

export async function fetchReddit(cfg, log) {
  const tok = await auth().catch((e) => {
    log(`reddit: auth failed (${e.message}), falling back to anonymous`);
    return null;
  });
  const root = base(tok);
  const h = headers(tok);
  const out = [];

  // Anonymous Reddit is rate-limited hard from most networks. Rather than burn
  // minutes on backoff for every request, bail after a few consecutive failures.
  let consecutiveFailures = 0;
  const tripped = () => consecutiveFailures >= 4;

  const collect = async (url, label, sub) => {
    if (tripped()) return;
    try {
      const json = await getJSON(url, { headers: h, retries: tok ? 3 : 1 });
      for (const c of json?.data?.children || []) {
        const job = normalize(c, sub);
        if (job) out.push(job);
      }
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      log(`reddit: ${label} failed — ${e.message}`);
    }
  };

  for (const sub of cfg.subreddits) {
    if (tripped()) break;

    for (const listing of cfg.listings) {
      await collect(
        `${root}/r/${sub}/${listing}.json?limit=${cfg.limit}&raw_json=1`,
        `r/${sub}/${listing}`,
        sub,
      );
    }

    for (const q of cfg.queries) {
      await collect(
        `${root}/r/${sub}/search.json?q=${encodeURIComponent(q)}` +
          `&restrict_sr=1&sort=new&t=month&limit=${cfg.limit}&raw_json=1`,
        `search "${q}" in r/${sub}`,
        sub,
      );
    }
  }

  if (tripped()) {
    log(
      tok
        ? 'reddit: too many consecutive failures — skipped the rest of this run'
        : 'reddit: rate-limited anonymously — set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (see README)',
    );
  }

  log(`reddit: ${out.length} raw posts${tok ? ' (oauth)' : ' (anonymous)'}`);
  return out;
}
