# bme-internship-bot

Finds entry-level **Biomedical Engineering internships / co-ops for undergrads**, deduplicates
them against what it has already reported, and emails you only the new ones.

Zero npm dependencies — plain Node ≥ 20.

## What it pulls from

| Source | Endpoint | Auth |
| --- | --- | --- |
| Reddit | official JSON API — `new` + keyword search across r/BiomedicalEngineering, r/biotech, r/internships, r/MedicalDevices, … | **OAuth required in practice** |
| Greenhouse | `boards-api.greenhouse.io` public board API | none |
| Lever | `api.lever.co/v0/postings` | none |
| Ashby | `api.ashbyhq.com/posting-api` | none |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies` | none |
| Community lists | SimplifyJobs internship repos (markdown tables on GitHub) | none |
| USAJOBS | `data.usajobs.gov` — NIH, FDA, VA, Army MRDC | free API key |

These are the documented JSON APIs the companies' own careers pages call, so there's no HTML
scraping to break, and requests are serialized behind a ~1s delay with backoff.

**Not covered:** Workday-based employers (Medtronic, Stryker, Boston Scientific, J&J, Abbott)
have no public API — check those manually or add their SmartRecruiters/Greenhouse subsidiaries.
LinkedIn and Indeed are excluded on purpose; scraping them violates their terms.

## Setup

```bash
cd bme-internship-bot
node src/index.js --setup     # credentials + test email
node src/index.js             # collect and email new matches
```

### Email (Gmail)

The bot sends to `barathb2306@gmail.com` by default. Gmail needs an **app password**, not your
account password — create one at <https://myaccount.google.com/apppasswords> (requires 2-Step
Verification to be on).

Then run setup and paste it when prompted — input is hidden, spaces are stripped for you, and it
sends a test email immediately so you know it worked:

```bash
node src/index.js --setup
```

Values are stored in `.env` (gitignored, `chmod 600`) so they survive across shells and scheduled
runs. Real environment variables still override the file if you'd rather `export` them, and you
can always edit `.env` by hand — see [.env.example](.env.example).

Verify delivery:

```bash
node src/index.js --test-email
```

Prefer an API to SMTP? Set `RESEND_API_KEY` instead and the bot uses Resend.

### Reddit OAuth — required in practice

Verified during testing: anonymous requests to `www.reddit.com/*.json` return **429** from this
network, so the Reddit source yields zero posts without credentials (the bot detects this, prints
a warning, and skips the rest of the Reddit sweep instead of burning minutes on backoff).

Create a **script**-type app at <https://www.reddit.com/prefs/apps> (name anything, redirect URI
`http://localhost:8080`), then add to `.env`:

```
REDDIT_CLIENT_ID=...       # the string under the app name
REDDIT_CLIENT_SECRET=...   # the "secret" field
```

The board sources need no credentials and work regardless.

## Usage

```bash
node src/index.js                    # collect → email new matches → save state
node src/index.js --dry-run          # print only; no email, no state change
node src/index.js --all              # re-send everything, not just new
node src/index.js --verify-sources   # which board tokens in config.json are alive
node src/index.js --discover         # resolve companies.txt -> board tokens, update config.json
node src/index.js --min 6            # stricter relevance threshold
```

## Adding companies

Don't hand-guess board slugs — they're unguessable one at a time. Add plain company names to
[companies.txt](companies.txt) and run:

```bash
node src/index.js --discover
```

It tries the common slug variants of each name (`bostonscientific`, `boston-scientific`,
`boston`, …) against all four providers, keeps whichever actually returns postings, and merges
the hits into `config.json`. Companies on Workday (Medtronic, Stryker, Abbott, J&J, …) will come
back as "no public board found" — that's expected, they have no public API.

## Tuning

Everything lives in [config.json](config.json):

- `greenhouse` / `lever` / `ashby` / `smartrecruiters` — company board slugs, normally generated
  by `--discover`. `--verify-sources` reports which are still alive.
- `scoring` — phrase weights. A posting is kept only if it scores > 0 on **both** an
  internship signal (`intern`, `co-op`, `undergraduate`, …) and a domain signal
  (`biomedical`, `medical device`, `biomechanics`, …), then clears `minScore`.
  Title matches count double body matches.
- `hardExcludeTitle` — instant rejects (`senior`, `principal`, `postdoc`, …).
- `season` — cosmetic label in the email plus a weighted keyword (`summer 2027`).
- `maxAgeDays` — ignore postings older than this when the source reports a date.

Getting noise? Raise `minScore`. Missing things? Lower it and add domain phrases.

## Running it on a schedule

**macOS (launchd)** — every day at 8am. Save as
`~/Library/LaunchAgents/com.bme.internship-bot.plist`, then
`launchctl load ~/Library/LaunchAgents/com.bme.internship-bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.bme.internship-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/barathbalaji/Documents/tourney-coach/bme-internship-bot/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SMTP_USER</key><string>barathb2306@gmail.com</string>
    <key>SMTP_PASS</key><string>APP_PASSWORD_HERE</string>
    <key>REDDIT_CLIENT_ID</key><string></string>
    <key>REDDIT_CLIENT_SECRET</key><string></string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/tmp/bme-bot.log</string>
</dict></plist>
```

**GitHub Actions** — if you'd rather it run in the cloud, commit `.github/workflows/bot.yml` with a
`schedule: cron` trigger, put the credentials in repo secrets, and cache `data/state.json` with
`actions/cache` so it remembers what it already sent.

## Files

```
src/index.js         CLI: collect → filter → diff → email
src/http.js          queued fetch: shared delay, backoff, HTML stripping
src/filter.js        relevance scoring + dedup fingerprints
src/sources/         reddit.js, boards.js
src/discover.js      company name -> live board token resolution
companies.txt        input for --discover
src/report.js        console / plain-text / HTML renderers
src/email.js         dependency-free SMTP client, Resend fallback
data/state.json      IDs already emailed (auto-pruned at 180 days)
data/latest.json     full result set from the most recent run
```

If the email send fails, state is **not** advanced — the next run retries those listings rather
than silently dropping them.
