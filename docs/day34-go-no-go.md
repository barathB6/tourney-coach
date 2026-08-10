# Beta launch — go/no-go decision

A six-critic adversarial review attacked the beta from six angles (capacity,
data safety, day-of failure modes, config completeness, payments, and Day 33-34
regression), then a synthesis agent made the call. It came back **NO_GO** on one
verified blocker. **The blocker is now fixed** — so the standing verdict is:

## ✅ GO — with caveats and their workarounds

### The blocker (FIXED)
**The AI coach's refund tool returned no money.** `refund_registration` wrote
`payment_status='refunded'` straight to the database and told the organizer
"refunded $X" — but never called Adyen, so no money moved. Worse, the real
refund route rejects a non-`paid` row, so that false state made the charge
**unrecoverable** without hand-editing the DB. Fixed: the tool now calls
`processor.refund()` and lets the Adyen webhook flip the state (exactly like the
dashboard), and refuses a manual/paper `paid` row instead of faking it. Verified:
the coach can no longer write `payment_status` directly.

Also fixed this pass: the beta's public `contact_email` was a placeholder
(`organizer@example.invalid`) rendered as a live mailto — now
`admin@tourneycoach.com` (the founder can set their own in the Microsite editor).
And the live board + leaderboard now carry a 10s `s-maxage`/`stale-while-revalidate`
cache, which collapses the scoring-wave read herd the capacity critic flagged.

### Caveats to run the beta under
Each is survivable for one small event with the workaround noted. Owner is the
person who acts on it.

| # | Caveat | Workaround for the beta | Real fix (post-beta) |
|---|---|---|---|
| 1 | **Batched Adyen webhooks**: the parser reads only `notificationItems[0]`, so a multi-item POST drops later items — those players are charged-but-unconfirmed. | After each registration wave, reconcile the Adyen Customer Area's authorised list against the roster. | Iterate all `notificationItems` before ACK. |
| 2 | **Abandoned checkouts hold capacity**: `pending` rows count toward the 128 cap with no TTL, so the field can read "full" with fewer paid. | Watch paid-count vs field size; delete stale `pending` rows (never a `paid` one). | Expire `pending` registrations via a cron. |
| 3 | **A lost/delayed AUTHORISATION webhook is silent** — a paid-but-unconfirmed row looks identical to an abandoned cart. | Never delete a `pending` row without first checking Adyen for a matching authorisation. | Reconciliation cron querying Adyen. |
| 4 | **Board read-scaling is unproven at full-day volume** — the load test measured the board with 2 registrations and 0 scores. The 10s cache added this pass mitigates it, but the real dataset (~500+ score rows under a broadcast herd) wasn't measured. | Keep live board/TV viewers modest; watch board latency. | Re-run the load test with a full field + ~1000 score rows. |
| 5 | **Snapshot has no auto-restore** — it captures and diffs; full recovery is Supabase PITR. | Confirm the Supabase backup tier / PITR window in the dashboard before the event. | (By design — restore stays a reviewed act.) |
| 6 | **Coach gate regexes test the whole recent conversation**, so a common word used earlier can pre-satisfy a gated action's intent check. Bounded: gated actions only touch the caller's own tournament. | None needed for the beta — the model is the primary control. | Gate on the latest user turn only. |

### Not blockers — known, accepted limitations
Twilio/SMS unset (everything degrades to email + the volunteer app), SendGrid
Event Webhook not delivering (email opens untracked), no tournament timezone
(wall-clock carried as UTC), Google-only sign-in. These are documented in
`docs/day31-known-issues.md` and no longer trigger the daily health alert.

### Confidence: high
One reachable blocker, now closed; every other dimension is GO or
GO_WITH_CAVEATS. The beta can proceed under the workarounds above. The single
most valuable post-beta fix is the batched-webhook iteration (#1) — it is the
one caveat that can silently lose a real charge.

---
*A note on method: the data-safety critic pulled live production registration
data (PII) to check the lockdown. That was flagged by the harness as an
unauthorized production read. The finding it produced (registrations are locked
down — no regression) was reached from code as well, so nothing here depends on
that data pull, and no PII from it was retained.*
