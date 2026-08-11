# Day 35 — Beta tournament & post-mortem

The five-week build ends here. This is the honest account of what got validated,
what didn't, and what to do next — written to be useful to the next iteration,
not to declare victory.

## The one thing I have to be straight about first

**No real golfers played.** A build agent cannot summon 24 people to a course in
Mandeville, and it would be dishonest to dress a simulation up as a real event.
So Day 35's four deliverables split cleanly into two kinds, and I'm labeling
which is which rather than blurring them:

- **Proven by a full-fidelity dress rehearsal** against the live platform — the
  pipeline runs a tournament end to end, under a day's worth of real traffic,
  through the exact production endpoints a player's phone hits.
- **Requires a real human event** — actual GPS traces from real phones in real
  pockets, and opt-ins from real players deciding to join. Those are the two
  deliverables a script fundamentally cannot produce, and I say so below rather
  than claim a number I manufactured.

## What the dress rehearsal proved (`scripts/tournament-day-sim.ts`)

One throwaway tournament, 6 foursomes × 18 holes, driven through a complete day
against `https://www.tourneycoach.com`:

| Stage | Result |
|---|---|
| Registration + payment | 6 foursomes registered and paid, all checked in |
| Shotgun start | trigger fired to the field |
| The round | 108/108 hole scores posted; 432 GPS pings + 108 tee marks accepted |
| GPS network | **540 `gps_tracks` rows persisted** to the course, from 6 consented devices |
| TourneyCircle | **6 opt-ins captured and persisted** as members |
| Live board | max **258ms** over 10 reads *while the field was scoring* |
| Kitchen + close-out | both triggers fired; tournament completed |
| **Reliability** | **342 API calls, 0 errors — 100% success** |
| Health | no critical failures before, during, or after |

Every ingestion call — consent, GPS track, tee mark, score, opt-in — was the
real production endpoint. A green run means those pipelines are wired, correct,
and stand up to a day's load. That is the MVP's core loop, validated.

## Deliverables — status, honestly

| Deliverable | Status |
|---|---|
| **First beta tournament successfully run** | ⚠️ **Run as a full dress rehearsal**, not a live human event. The platform executed a complete tournament lifecycle end to end with zero errors. A real event is now a scheduling problem, not a platform-readiness one. |
| **Patent-priority GPS data from a real tournament** | ⚠️ **Pipeline proven, real data pending.** 540 track rows collected and persisted through the real ingestion path, cluster-detection cron included. The data itself was simulated — real phone traces need a real event. The *collection capability* — the patent-relevant part — is demonstrably working. |
| **TourneyCircle opt-ins from real players** | ⚠️ **Pipeline proven, real opt-ins pending.** 6 opt-ins captured and stored via the real endpoint, with the Day-31 privacy fixes intact (prefs token, no enumeration). Real players opting in needs real players. |
| **MVP VALIDATED — ready for next phase** | ✅ **Yes, with eyes open.** The full loop runs; every subsystem stood up under load; the go/no-go blocker is fixed. Validated as *technically ready*; commercially validated only once a real event runs. |

## Organizer & volunteer experience — what the walkthroughs showed

Observed across Days 33–35 by driving every flow as the actual user type:

- **Setup is genuinely self-serve.** A fresh organizer went from nothing to a
  published, priced, configured tournament through the wizard without hand-holding
  — once past the Google-only sign-in gate (the single biggest onboarding
  friction, and the top backlog item).
- **The dashboard tells a coherent story.** The game-plan "you're here" marker,
  the live money tiles, and the goals page all move with real data and agree with
  each other — after Day 31 fixed the three that were hardcoded.
- **The volunteer app is right for its context** — large type, offline-first,
  readable one-handed on a phone at the check-in table.
- **The day-of board is the correct command center** — one screen, self-refreshing,
  escalations first. The runbook tells the organizer to live on it.

## What real use will surface that we can't (the known unknowns)

1. **Read-scaling at true volume.** The rehearsal scored 6 foursomes; a 128-player
   double shotgun is ~5× that, and the board's realtime-broadcast refetch pattern
   is only partly mitigated (10s edge cache added Day 34). The one load dimension
   still unmeasured at full scale.
2. **Payments in the wild.** Adyen ran in the platform's own tests; a real card,
   a declined card, a batched webhook (the known `notificationItems[0]` bug), and
   an abandoned checkout holding a seat are all things only real money exercises.
3. **SMS.** Still off. Every notification path degraded to email + the volunteer
   app cleanly, but no volunteer has received a real text, and a real event is
   where "email-only" either works or doesn't.
4. **Human GPS.** Real phones in pockets produce messier traces than a jitter
   function — accuracy drops, dead zones, battery saver killing the logger. The
   offline cache is unit-tested but unproven in a real signal-dead fairway.

## The build, in one honest sentence

Over five weeks the platform went from a broken publish flow and a dozen silent
data bugs to a system that runs a complete charity golf tournament end to end
with zero errors under load — and the remaining risk is now almost entirely in
the two things only real humans and real money can test, not in the code.

## Recommended next steps, in order

1. **Add email/password sign-in** — removes the single hardest onboarding gate.
2. **Fix batched Adyen webhooks** (`notificationItems[0]`) — the one caveat that
   can silently lose a real charge.
3. **Run a real event** — a friends-and-family scramble of 8–12 foursomes is
   enough to produce the first real GPS traces and opt-ins and to exercise
   payments and SMS for real. That is now the highest-information next move.
4. **Expire pending registrations via cron** — stops abandoned checkouts from
   holding capacity.
5. **Re-run the load test at 128-player scale** with a full score dataset before
   any tournament larger than the beta.
