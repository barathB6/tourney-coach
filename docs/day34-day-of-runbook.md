# Tournament day runbook — for the beta organizer

Everything you need on the morning of the **Northshore Charity Golf Classic**
(Sep 19, 8:00 AM shotgun). Written to be read once the night before and glanced
at on the day. If something feels wrong, the last section is who to call.

## The night before

1. **Check the platform is healthy.** Open
   `https://www.tourneycoach.com/api/health`. You want `status` to be `ok` or
   `degraded` — never `down`. `degraded` is expected: it means SMS and a couple
   of optional integrations are off (see *Known limitations*), not that anything
   is broken.
2. **Snapshot your config.** From the project, run
   `npx tsx scripts/snapshot-tournament.ts northshore-charity-golf-classic`.
   That writes a restore-from file in case an edit goes wrong on the day.
3. **Confirm the roster.** Dashboard → Registrations. Every paid foursome should
   be there with a foursome number and a starting hole. If a starting hole is
   blank, open Shotgun Start and assign.
4. **Confirm your day-of team.** Dashboard → Your Team → Day-of. The two roles
   that must have a real person with a real phone/email are **Registration
   Lead** and **Kitchen Liaison**.

## The morning — what you do, in order

| Time | You do | The platform does |
|---|---|---|
| ~6:00 | Registration Lead sets up the check-in table | — |
| ~7:00 | Open the **Day-of Board** (`/dayof`) on your phone — this is your command center for the day | Live board, self-refreshing every 30s |
| 8:00 | Field tees off. Tap **Shotgun started** on the board | Notifies every confirmed day-of volunteer that play has begun |
| mid-round | As the field moves, tap the triggers as they happen (see below) | Each notifies just the roles that need it |
| ~45 min before finish | Kitchen fires — tap **Kitchen fired** (or it can auto-fire from pace) | Tells the Kitchen Liaison and Awards crew to start |
| last group in | Tap **Last group in** | Releases scoring/takedown |
| awards | Tap **Awards starting** | Cues awards crew, photographer, contest monitors |
| done | Tap **Tournament complete** | Closes the event out |

### The day-of triggers, and who each one reaches
Every trigger is **idempotent** — tapping twice does nothing the second time, so
you can never double-notify. There is **no undo**, so a wrong tap means telling
people verbally to ignore it; the triggers are cheap, so when in doubt, wait.

- **Shotgun started** → all confirmed day-of volunteers
- **Last group teed off** → Registration Lead / Volunteer (they can break down check-in)
- **Field reached the turn** → Beverage Cart, Scoring Runner
- **First group finished** → Scoring Runner, Awards Setup
- **Kitchen fired** → Kitchen Liaison, Awards Setup
- **Last group in** → Scoring Runner, Awards Setup, Takedown
- **Awards starting** → Awards Setup, Photographer, Contest Monitors
- **Tournament complete** → closes the tournament

## Scoring during the round

- Players score on their phones via their round link. It works **offline** —
  scores queue on the phone in a dead zone and sync when signal returns, so a
  patchy back-nine doesn't lose anything.
- The **live leaderboard** (`/tv/<id>` for the clubhouse TV, or the board) shows
  standings as scores post.
- If a score is wrong, you fix it: dashboard → Registrations → the team → Fix
  score, or ask the coach ("correct hole 7 for the Smith foursome to 4"). Every
  correction keeps history and is audited.

## Known limitations — plan around these

- **SMS is OFF.** Every day-of trigger, volunteer reminder and the kitchen alert
  goes by **email**, not text — and volunteers see it **in the volunteer app**
  regardless. Tell your volunteers up front: *watch your email and keep the
  volunteer page open on your phone.* Nothing silently fails; it just doesn't
  text. (The board and the volunteer app are the reliable channel — treat email
  as the backup, not the primary.)
- **Times are wall-clock.** "8:00 AM" means 8:00 at the course. Everything reads
  correctly as written; don't overthink it.
- **Push notifications** work but are unproven on a real device — don't rely on
  them as the only channel. Email + the volunteer app are your reliable pair.

## The safest single habit

Keep the **Day-of Board** (`/dayof`) open on your phone all day. It is the one
screen that shows everything: who's checked in, what's been sent, what's overdue,
and any volunteer message that needs you. If you only look at one thing, look at
that.

## If something goes wrong — escalation

1. **A number looks wrong** (spots, money, a score) — it's derived live, so
   refresh first; it's almost always a stale view, not bad data.
2. **A volunteer didn't get notified** — the board shows what was sent; re-tap
   is safe (idempotent). With SMS off, point them at their email / the volunteer
   app.
3. **Payment taken but no confirmation** — this is monitored and reported
   automatically; the registration reconciles when Adyen's webhook lands. If a
   player is charged and not on the roster after a few minutes, add them manually
   (Registrations → Add) and note it.
4. **The platform itself is down** — check `/api/health`. If `status: down`, it
   names the cause. Email **admin@tourneycoach.com** with your tournament name
   and "TOURNAMENT DAY" in the subject.

Run the day off the board, tell your volunteers to watch email + the volunteer
app, and you're covered.
