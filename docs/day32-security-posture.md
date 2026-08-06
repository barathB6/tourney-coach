# Security posture review — Day 32

Written to be actionable, not reassuring. Every claim below is backed by a probe
in `scripts/audit-security.ts`, which runs as an attacker rather than reading
policy text — because reading policy text is exactly what would have missed the
one serious finding.

Re-run it any time:

```bash
E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/audit-security.ts
```

## The finding that mattered

**`registrations` was readable by the anon key** — the key shipped in every
visitor's browser bundle. All 56 rows across all 11 tournaments: 40 distinct
email addresses, contact names, phone numbers, the `players[]` rosters,
`player_profile_id`, and Adyen PSP references. Draft tournaments included. No
credential required beyond opening the site.

Migration 003 only ever created an organizer-scoped SELECT policy, which returns
nothing for anon — so the exposure came from a grant or policy added outside the
migrations flow. That is precisely the class of problem migration 025 was written
to sweep up, and `registrations` sat on 025's allow-list, so the sweep skipped
it. The allow-list entry existed because the browser was believed to need anon
INSERT for public signups. It did not: every server path uses the service role,
and inserts go through `create_registration_atomic`.

Closed by **migration 048**, which drops every policy on the table by name from
the catalog and rebuilds them, revokes anon outright, and removes the
`WITH CHECK (true)` insert policy that let anyone write arbitrary rows.

Writes were always refused, so nothing was modified. Read exposure duration is
unknown — the grant predates this audit and is not in migration history.

## Current posture

| Area | State | Evidence |
|---|---|---|
| Private tables | 13 tables closed to anon **and** to a signed-in stranger | `permission denied` on every one |
| Tenant isolation | 22 owned tables leak nothing to an organizer who owns nothing | 0 rows or `permission denied` |
| Anonymous writes | Refused on every table in the schema | RLS or constraint on all 38 |
| Public reads | Only `courses`, `course_holes`, `sponsorship_tiers`, and **published** tournaments | drafts invisible; updates refused |
| Privilege escalation | A signed-in user cannot write `profiles.role` | `permission denied for table profiles` |
| Cron endpoints | All 5 refuse a missing **and** a wrong `CRON_SECRET` | 401 on both |
| Injection | 7 payloads (SQLi, traversal, XSS, template, NUL, 20KB) survive | 400s, schema intact |
| Secret scoping | No secret in any client component; no secret in the served bundle | grep of `'use client'` files + the production HTML |

Every `NEXT_PUBLIC_*` variable is genuinely public by design: the Supabase URL
and anon key, the Google client id, the VAPID **public** key, the app URL.

## Known gaps, ranked

1. **`SENDGRID_WEBHOOK_PUBLIC_KEY` is unset**, so the engagement webhook accepts
   unsigned batches. The code verifies when the key is present and logs a
   one-time warning when it is not. This is exploitable with a leaked uuid:
   forged `open` events advance a donation prospect's status and mark a
   volunteer's reminder read, which is a real input — the guidance engine reads
   unopened email to decide whether to escalate someone to SMS. **Fix: enable
   Signed Event Webhook in SendGrid and set the key.**

2. **`VOLUNTEER_CODE_PEPPER` is unset**, so code hashing falls back to the
   service role key. It works, and the fallback is documented, but it couples
   two secrets: rotating one rotates the other, and a service-key rotation
   silently invalidates every outstanding volunteer code. **Fix: set a
   dedicated pepper.**

3. **The registration id is a bearer credential** for the live round, the
   scorecard and GPS. That is a deliberate design — a player has no account —
   and the organizer legitimately holds one per player. Day 31 removed the one
   place where it was doing more than that (reading and writing cross-tournament
   TourneyCircle data). Worth re-checking whenever a new surface keys off it.

4. **`tournaments` exposes more columns publicly than the microsite needs** —
   `organizer_id`, `charity_ein`, `charity_address`, `contact_email` all come
   back to anon for a published tournament. An EIN is public record and the
   contact email is printed on the microsite by design, so this is low severity,
   but a column-scoped view would be tidier than a whole-row policy.

5. **No rate limiting on public POST endpoints** other than volunteer code
   issuance. `/api/registrations` and `/api/sponsors/purchase` are open to
   automated submission. Capacity is enforced atomically so the field cannot be
   oversold, but a script could fill it with junk pending registrations and deny
   real players their seats. Vercel's platform protections are the only thing
   in front of this today.

## What is enforced in the database rather than in app code

This is the part that matters most, because app-level checks are one refactor
from being skipped:

- **Capacity, foursome numbering and insert** — `create_registration_atomic`
  (011), which locks the tournament row. Twelve simultaneous foursomes against
  an 8-player field accept exactly two.
- **Access-code issuance and verification** — `issue_volunteer_code` and
  `verify_volunteer_code` (047), under an advisory lock and a row lock. Before
  this, ten simultaneous requests minted nine codes against a cap of five, and
  five parallel wrong guesses burned **one** attempt between them, leaving the
  correct code alive.
- **Send idempotency** — partial unique indexes on the ledger tables, claimed
  before the provider is called, so the loser of a race gets 23505 and sends
  nothing.

All three are asserted by `scripts/stress-concurrency.ts`.

## Production readiness

**Ready, with two configuration items outstanding** (the two SendGrid/pepper
gaps above, neither of which blocks a beta) and the items in
`docs/day31-known-issues.md` — Twilio unset since Day 27, push blocked on empty
VAPID values in Vercel, and the missing tournament timezone column.

`/api/health` is the single place to check this: it reports `down` when a
migration the running code depends on is missing (and names the migration),
`degraded` when a delivery channel or integration is out, and `ok` only when
everything a tournament needs is wired. A daily cron mails admin@ when it is not
`ok`, and repeats daily until it is.
