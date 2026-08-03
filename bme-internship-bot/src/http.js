// Polite HTTP helper: single shared queue, fixed delay between requests,
// exponential backoff on 429/5xx. Every source funnels through this so we
// never hammer a job board.

const UA =
  process.env.BOT_USER_AGENT ||
  'bme-internship-bot/1.0 (personal job-search aggregator; contact: set BOT_USER_AGENT)';

let chain = Promise.resolve();
let delayMs = 900;

export function setDelay(ms) {
  delayMs = ms;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serialize all outbound requests with a delay between them. */
function queued(fn) {
  const result = chain.then(fn);
  chain = result.then(
    () => sleep(delayMs),
    () => sleep(delayMs),
  );
  return result;
}

export function getJSON(url, { headers = {}, retries = 3 } = {}) {
  return queued(async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 404) return null; // dead board token — caller decides
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}`); // transient — worth retrying
        }
        if (!res.ok) {
          const permanent = new Error(`HTTP ${res.status}`);
          permanent.permanent = true; // 401/403/400 won't fix themselves
          throw permanent;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (err.permanent) break;
        if (attempt < retries) await sleep(1500 * 2 ** attempt);
      }
    }
    throw lastErr;
  });
}

export function getText(url, { headers = {} } = {}) {
  return queued(async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
}

export function postForm(url, body, headers = {}) {
  return queued(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  });
}

export function stripHTML(html = '') {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}
