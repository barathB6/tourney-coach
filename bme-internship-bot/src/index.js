#!/usr/bin/env node
// bme-internship-bot — collects entry-level biomedical engineering internships
// from Reddit and public company job-board APIs, then emails what's new.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setDelay, getJSON } from './http.js';
import { fetchReddit } from './sources/reddit.js';
import {
  fetchGreenhouse,
  fetchLever,
  fetchAshby,
  fetchSmartRecruiters,
  fetchGitHubLists,
  fetchUSAJobs,
} from './sources/boards.js';
import { applyFilters } from './filter.js';
import { Store } from './store.js';
import { toConsole, toPlainText, toHTML } from './report.js';
import { sendEmail, emailConfigured } from './email.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load .env (gitignored) so credentials survive across shells and cron jobs.
// Real environment variables always win over the file.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const NOTIFY_TO = process.env.NOTIFY_TO || 'barathb2306@gmail.com';
const log = (msg) => process.stderr.write(`${new Date().toISOString().slice(11, 19)}  ${msg}\n`);

if (has('--help')) {
  console.log(`bme-internship-bot

  node src/index.js --setup         enter credentials interactively, then send a test email
  node src/index.js                 collect, save, email new matches
  node src/index.js --dry-run       collect and print; no email, no state written
  node src/index.js --all           email/print everything, not just new
  node src/index.js --verify-sources  check which board tokens in config.json resolve
  node src/index.js --test-email    send a one-line test email and exit

Options
  --config <path>   config file (default ./config.json)
  --state  <path>   seen-jobs file (default ./data/state.json)
  --min <n>         override minimum relevance score
  --to <email>      override recipient (default ${NOTIFY_TO})

Environment
  SMTP_USER, SMTP_PASS        Gmail address + 16-char app password
  SMTP_HOST, SMTP_PORT        default smtp.gmail.com:465
  RESEND_API_KEY              use Resend instead of SMTP
  REDDIT_CLIENT_ID/SECRET     optional but strongly recommended
  USAJOBS_API_KEY/EMAIL       optional, enables federal (NIH/FDA/VA) listings
`);
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(arg('--config', path.join(ROOT, 'config.json')), 'utf8'));
if (arg('--min')) config.minScore = Number(arg('--min'));
setDelay(config.requestDelayMs ?? 900);

const recipient = arg('--to', NOTIFY_TO);

if (has('--setup')) {
  const { runSetup } = await import('./setup.js');
  const ok = await runSetup(envFile, { user: process.env.SMTP_USER, notifyTo: NOTIFY_TO });
  if (!ok) process.exit(1);
  log('sending a test email to confirm...');
  try {
    await sendEmail({
      to: recipient,
      subject: 'BME internship bot — setup complete',
      text: 'Email delivery is working. Run the bot with: node src/index.js',
      html: '<p>Email delivery is working.</p><p>Run the bot with <code>node src/index.js</code>.</p>',
    });
    log(`success — check ${recipient}`);
  } catch (e) {
    log(`send failed: ${e.message}`);
    if (/535|Username and Password not accepted/i.test(e.message)) {
      log('535 = Gmail rejected the credentials. Check that 2-Step Verification is on and');
      log('that you pasted an *app password* (16 chars), not your account password.');
    }
    process.exit(1);
  }
  process.exit(0);
}

if (has('--test-email')) {
  if (!emailConfigured()) {
    log('No email credentials found. Run: node src/index.js --setup');
    process.exit(1);
  }
  const via = await sendEmail({
    to: recipient,
    subject: 'BME internship bot — test',
    text: 'Email delivery is working.',
    html: '<p>Email delivery is working.</p>',
  });
  log(`test email sent to ${recipient} via ${via}`);
  process.exit(0);
}

if (has('--discover')) {
  const listPath = arg('--companies', path.join(ROOT, 'companies.txt'));
  const names = fs
    .readFileSync(listPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // Probes are spread across four different hosts and are single HEAD-ish
  // reads, so a shorter gap than the collection run is still polite.
  setDelay(Number(arg('--delay', 200)));
  log(`probing ${names.length} companies across 4 providers — this takes a few minutes`);
  const { discover } = await import('./discover.js');
  const found = await discover(names, log);

  const configPath = arg('--config', path.join(ROOT, 'config.json'));
  const merged = { ...config };
  for (const provider of Object.keys(found)) {
    merged[provider] = [...new Set([...(config[provider] || []), ...found[provider]])];
  }
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  log(`config.json updated: ${Object.keys(found).map((p) => `${p} ${merged[p].length}`).join(', ')}`);
  process.exit(0);
}

if (has('--verify-sources')) {
  const checks = [
    ...config.greenhouse.map((t) => [
      'greenhouse',
      t,
      `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    ]),
    ...config.lever.map((t) => ['lever', t, `https://api.lever.co/v0/postings/${t}?mode=json`]),
    ...config.ashby.map((t) => [
      'ashby',
      t,
      `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    ]),
    ...config.smartrecruiters.map((t) => [
      'smartrecruiters',
      t,
      `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=1`,
    ]),
  ];
  for (const [kind, token, url] of checks) {
    try {
      const json = await getJSON(url);
      // SmartRecruiters answers 200 with an empty page for unknown companies,
      // so an empty board counts as dead, not merely quiet.
      const n = json ? (json.jobs?.length ?? json.totalFound ?? json.length ?? 0) : 0;
      console.log(`${n > 0 ? 'OK  ' : 'DEAD'} ${kind.padEnd(16)} ${token}  (${n} postings)`);
    } catch (e) {
      console.log(`ERR  ${kind.padEnd(16)} ${token}  ${e.message}`);
    }
  }
  process.exit(0);
}

// ---- collect -------------------------------------------------------------
const started = new Date().toISOString();
log(`collecting — target season ${config.season}, min score ${config.minScore}`);

const batches = await Promise.allSettled([
  fetchReddit(config.reddit, log),
  fetchGreenhouse(config.greenhouse, log),
  fetchLever(config.lever, log),
  fetchAshby(config.ashby, log),
  fetchSmartRecruiters(config.smartrecruiters, log),
  fetchGitHubLists(config.githubLists, log),
  config.usajobs?.enabled ? fetchUSAJobs(config.usajobs, log) : Promise.resolve([]),
]);

const raw = batches.flatMap((b) => {
  if (b.status === 'fulfilled') return b.value;
  log(`source failed entirely — ${b.reason?.message || b.reason}`);
  return [];
});

const matches = applyFilters(raw, config);
log(`${raw.length} raw → ${matches.length} relevant`);

// ---- diff against what we've already reported -----------------------------
const statePath = arg('--state', path.join(ROOT, 'data', 'state.json'));
const store = new Store(statePath);
const fresh = has('--all') ? matches : matches.filter((j) => store.isNew(j));
log(`${fresh.length} new since last run (${store.size} previously seen)`);

console.log(toConsole(fresh));

if (has('--dry-run')) {
  log('dry run — nothing emailed, state not written');
  process.exit(0);
}

// ---- notify ---------------------------------------------------------------
if (fresh.length) {
  if (!emailConfigured()) {
    log('WARNING: no email credentials set — results printed above but not emailed.');
  } else {
    const subject = `${fresh.length} new BME internship${fresh.length === 1 ? '' : 's'} — ${
      fresh[0].company
    }${fresh.length > 1 ? ` +${fresh.length - 1} more` : ''}`;
    try {
      const via = await sendEmail({
        to: recipient,
        subject,
        text: toPlainText(fresh, config.season),
        html: toHTML(fresh, config.season),
      });
      log(`emailed ${fresh.length} listing(s) to ${recipient} via ${via}`);
    } catch (e) {
      log(`EMAIL FAILED — ${e.message}. State not advanced; next run will retry these.`);
      process.exit(1); // leave them unseen so nothing is silently lost
    }
  }
}

for (const job of fresh) store.record(job, started);
store.prune();
store.save(started);

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'data', 'latest.json'),
  JSON.stringify({ runAt: started, total: matches.length, new: fresh.length, jobs: matches }, null, 2),
);
log('done');
