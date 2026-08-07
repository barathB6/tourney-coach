# Day 31 — what was fixed, and what is still open

Integration testing for the beta tournament. This is the honest ledger: what
the audit and the new suites found, what got fixed, and what is knowingly still
broken or unproven going into Days 32–35.

## How the findings were reached

A six-area adversarial audit produced 18 candidate findings. Its verifier
agents all died on a session limit, so its own verdict — "0 confirmed, 18
refuted" — was worthless. Every finding below was re-verified by reading the
implicated code directly. Sixteen of the eighteen were real. Two more came out
of the new concurrency suite, and one (`Leave TourneyCircle` doing nothing) came
out of reading the send path while fixing something else.

## Fixed on Day 31

### Cross-tenant / privacy

| # | Where | What it was |
|---|---|---|
| 1 | `app/api/circle/opt-in/route.ts` | Identity was the **registration id** — the round-link credential, which the organizer holds for every player at their own event. `GET ?reg=` returned a named player's TourneyCircle membership, radius and cause preferences; `POST` overwrote their home location and preferences. Repeated down a roster it rebuilds the private member list. Now keyed on `prefs_token` (046), delivered only by email. |
| 2 | `app/api/tournament/[id]/comm/route.ts` | `run_reminders` called `runCadence()` with no tournament scope, so one organizer's button sent **every** organizer's due reminders and returned their volunteer UUIDs and raw provider errors. |
| 3 | `lib/circle/send.ts` | **"Leave TourneyCircle" did not leave.** `tourneycircle_declines` was written by the opt-in prompt and read by nothing. A player who declined, or who left, stayed in every subsequent paid blast. Consent is now enforced on the send path, and leaving deletes the membership. |
| 4 | `app/api/tournament/[id]/circle/route.ts` | `member_type` sub-counts passed through raw once the total cleared the ladder — a disclosed total of 6 could print "1 corporate", one identifiable company. Each type now runs its own ladder. |
| 5 | `app/api/tournament/[id]/circle/route.ts` | `byCause` used a per-bucket floor, so a cause at 5 (15mi) and 6 (25mi) named the one person in that ring. Each cause now runs its own ladder. |
| 6 | `app/api/tournament/[id]/circle/route.ts` | Displayed counts applied behavioral suppression, which keys off registrations and visits the organizer can manufacture — adding one registration and watching the count drop by one answered "is this person in the Circle?". Display is now computed without suppression; suppression still governs the actual send. |
| 7 | `app/api/tournament/[id]/meetings/route.ts` | Attendance PATCH upserted **any** volunteer uuid in the system, creating cross-tenant rows and an id-existence oracle. |

### Money and pipeline

| # | Where | What it was |
|---|---|---|
| 8 | `app/api/cron/sponsor-followups/route.ts` | The post-send update had no status guard, and an Anthropic draft plus a SendGrid send sat between the query and the write. A reply landing in that window was dragged back to `contacted` — or to terminal `no_reply` — burying the reply behind a "No reply" chip. Also re-reads status immediately before sending now. |
| 9 | `app/api/webhooks/sendgrid-inbound/route.ts` | The terminal set omitted `verbal` and `pending`. An inbound email (an out-of-office would do) knocked `verbal` back to `replied`, **reopening a quantity-1 sold-out tier for a second sale**, and knocked `pending` out from under the Adyen `.eq('status','pending')` flip — card charged, sponsor never marked paid. |
| 10 | `app/sponsors/page.tsx` | The client auto-flagged `no_reply` at 5 days; the cron only chases `contacted` and only becomes eligible at 7. The page always won, so **the automated follow-up cadence had never once run**. Staleness is derived on render now. |
| 11 | `app/api/registrations/route.ts` | A **draft** tournament accepted public registrations — a stranger with the id could be charged for an unannounced event whose date and price were still being edited. The organizer's manual path stays exempt. |

### Correctness

| # | Where | What it was |
|---|---|---|
| 12 | `lib/toc/load.ts` | Marketing reach counted every non-failed `communication_log` row, but `sendComm` writes an in-app mirror per send — so reach doubled, and a **failed** send still scored one via its `delivered` mirror. |
| 13 | `lib/toc/load.ts` | "Donation items" counted every prospect row, including never-contacted and declined ones. Now counts `committed`. |
| 14 | `lib/donations/outreach.ts` | The follow-up claim key came from the prospect's mutable `follow_up_count`, so the cron and a manual send computed different slots and both cleared the unique index — two asks to one vendor. Derived from the outreach log now. |
| 15 | `app/team/page.tsx` | `datetime-local` sent a naked wall-clock string that the **server** parsed in server time. A chair in Central booked 6:30pm and got 1:30pm back. |
| 16 | `app/api/tournament/[id]/meetings/route.ts` | "Save notes" wrote `agenda: null` and vice versa, erasing the other field. |
| 17 | `app/api/tournament/[id]/team/route.ts` | Volunteer reuse matched email with `ilike`, so `_` and `%` were wildcards — `a_b@x.com` attached a role to whoever held `axb@x.com`. |
| 18 | `lib/toc/phase.ts` | Anchors were built without a `Z`, so they parsed in **server-local** time — identical on Vercel (UTC), four hours off on a developer's laptop. |
| 19 | `app/api/webhooks/sendgrid/route.ts` | The event webhook accepted unauthenticated POSTs. Signature verification added; still permissive until `SENDGRID_WEBHOOK_PUBLIC_KEY` is set (see below). |
| 20 | `app/setup/SetupClient.tsx`, `app/api/tournaments/route.ts`, `lib/tournaments.ts` | The setup wizard **never asked for a start time** and the create route silently dropped `shotgun_time`. Every volunteer reminder, run sheet, kitchen timeline and the volunteer app's WHEN card had been anchoring to a fallback 8:00 AM until the organizer happened to visit Public Page settings. |

### Races (found by `scripts/stress-concurrency.ts`, fixed by migration 047)

| # | Where | What it was |
|---|---|---|
| 21 | `lib/volunteer/accessCode.ts` | `issueCode` counted rows then inserted. Ten simultaneous requests minted **nine** codes against a cap of five — a wider guessing window, and an unbounded SendGrid/Twilio bill anyone can run up knowing a volunteer's email. |
| 22 | `lib/volunteer/accessCode.ts` | `verifyCode` read `attempts`, compared, then wrote. Five parallel wrong guesses **burned one attempt between them**, and the correct code still worked afterwards — the five-guess cap was defeatable by racing. |

## Migrations this needs

Both must be applied. Until then the affected code takes a documented fallback
path and says so.

- **`db/migrations/046_circle_prefs_token.sql`** — TourneyCircle opt-in returns
  a 500 with "run migration 046" until applied.
- **`db/migrations/047_volunteer_code_atomicity.sql`** — access-code limits fall
  back to the old racy read-then-write until applied.

## Still open

### Blocked on credentials or hardware — cannot be closed by code

- **Twilio is unset** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER`). Outstanding since Day 27. Every SMS path — kitchen
  sheets, volunteer invites and reminders, day-of triggers, phone-based
  volunteer login — degrades to email or to nothing. The guidance engine's
  channel selection is written and tested, but its SMS branch has never
  delivered a real message.
- **A2P 10DLC registration** — a Twilio console task. Without it, US carriers
  filter application-to-person SMS regardless of credentials.
- **Real-phone testing** — no SMS has been delivered to a real handset.
- **Push: FIXED and credential-proven (2026-08-07).** The Day 32 health check
  caught it, and the cause turned out to be twofold. First,
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is inlined at BUILD time and Vercel withholds
  Sensitive variables then, so the client shipped
  `applicationServerKey: undefined` — fixed by serving the key at runtime from
  `/api/push/key`. Second, all four VAPID variables were stored in Vercel with
  EMPTY values: they appeared in `vercel env ls` but read as unset at runtime,
  which is why `/api/push/key` still returned "not configured" after the code
  fix. Re-added from the local keypair, which was validated first — `web-push`
  signed a JWT with it. Now proven at the credential level: a signed push to a
  deliberately fake FCM token returns **410 (subscription expired), not
  401/403**, so Google accepted our VAPID signature and rejected only the fake
  subscription. Still unproven: delivery to a real registered device, which
  needs a real phone.
- **Offline mode is unproven in a real dead zone.** The localStorage cache and
  replay queue are unit-tested; a golf course with no signal is not the same
  test.

### Known limitations, deliberately not fixed

- **No tournament timezone.** `shotgun_time` is free text with no zone, and
  `tournaments` has no timezone column. The platform carries "8:30 AM" through
  as `08:30Z` end to end, and formats with `timeZone: 'UTC'` everywhere. That is
  self-consistent, and correct for a server in UTC, but a reminder scheduled 30
  minutes before an 8:30 shotgun fires at 08:00 **UTC** — 3:00 AM in Louisiana.
  For a single beta tournament this is invisible only if the cron's daily
  granularity hides it. **This is the highest-value thing left to fix** and
  wants a `timezone` column plus a real zone-aware anchor.
- **`SENDGRID_WEBHOOK_PUBLIC_KEY` is not set**, so the event webhook still
  accepts unsigned batches. Enable Signed Event Webhook in SendGrid
  (Settings → Mail Settings) and set the key; the code already verifies when it
  is present, and logs a one-time warning when it is not.
- **The apex domain drops the Authorization header.** `https://tourneycoach.com`
  redirects to `https://www.tourneycoach.com` and the redirect loses the bearer
  token, so authenticated API calls to the apex return 401. Everything in-app
  uses relative URLs so this only bites external callers and test scripts
  (`E2E_BASE_URL` must use `www`).
- **Organizer sign-in is Google-only.** There is no email/password door in the
  UI, which is fine, but it means test accounts cannot sign in through the
  browser without injecting a session.

### Unverified figures

- The F&B worked example (72 players / October / 78°F → 10/10/4/4/9 packs, 89
  portions) is **my derivation**, pinned in tests. The "validated quantities"
  referenced in the Day 28 spec were never provided, so these numbers are
  internally consistent but not externally confirmed.

## Test suites

| Suite | What it proves |
|---|---|
| `scripts/e2e-platform.ts` | The spec's whole walkthrough — signup → tournament → team → sponsors → registrations (incl. the capacity edge and the draft gate) → F&B → donation ask → guidance → tournament day → post-tournament → tenancy probes. 40 assertions. |
| `scripts/stress-concurrency.ts` | Six races asserted on exactly-once: capacity, cadence, day-of triggers, donation outreach, code issuance, code guessing. |
| `scripts/e2e-phase-e.ts` | TourneyCircle privacy, updated to the new credential and disclosure contract. |

Run them against a live base URL:

```bash
E2E_BASE_URL=https://www.tourneycoach.com npx tsx scripts/e2e-platform.ts
```
