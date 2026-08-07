# Beta tournament setup runbook

The repeatable process for standing up a real tournament on TourneyCoach, written
from an actual Day 33 dry run — a fresh organizer account taken through the real
product flow, start to finish. The reference tournament it produced is
**Northshore Charity Golf Classic** (Sep 19, 2026, Beau Chene Country Club),
live at `/microsite/northshore-charity-golf-classic`.

## Before you start — the one hard requirement

**Sign-in is Google-only.** There is no email/password sign-up in the product.
The beta organizer must have a Google account and use *Organizer login → Sign in
with Google*. A beta organizer without Google cannot self-onboard today — flag
this before scheduling any onboarding, because it is a dead end at the very first
screen, not a preference. (Adding email/password auth is the top onboarding
backlog item; see `docs/day33-beta-findings.md`.)

## The path, step by step

### 1. Sign in and open setup
- Landing page → **Organizer login** → **Sign in with Google**.
- New organizers land on the setup wizard at `/setup/format`. If not, the
  dashboard has a "New tournament" entry point.

### 2. The 6-step wizard (`/setup/format`)
Every step autosaves — closing the tab and coming back resumes exactly where you
left off.

1. **Format** — Scramble is pre-selected and is the right call for a charity
   field (Coach's note explains why). 
2. **Field size & start method** — player count (36/72/128/144), shotgun type,
   max-score rule. 128 + double shotgun is the common charity setup.
3. **Date & course** — event date, **shotgun start time** (this drives every
   volunteer call time and the kitchen schedule — set it deliberately), and the
   course. If the course isn't listed, "Enter a course manually".
4. **Pricing** — tournament name and entry fee *per player*. The wizard shows the
   derived per-foursome price and projected revenue live. A $125/player fee =
   $500/foursome = $16,000 at 128 players.
5. **Sponsors** — optional; skip and add later from the dashboard.
6. **Review & publish** — check the summary, click **Publish Tournament**.

After publishing you land on the dashboard, and the tournament is **published**
— its microsite is live and registration is open immediately. (Before Day 33 the
button created a draft and there was no way to publish; that is fixed.)

### 3. Publish / unpublish control
`Dashboard → Microsite` shows a status banner at the top:
- **Draft** (amber) — invisible to everyone; the microsite link 404s and
  registration is refused. Click **Publish tournament** to go live.
- **Published** (green) — public and open. Click **Unpublish** to pull it back
  while you keep editing.

Anyone with a tournament stuck in draft (there were 16 in the database before
this control existed) publishes it here.

### 4. Configure the rest from the dashboard
The dashboard game plan walks these in order and moves a "YOU'RE HERE" marker as
each completes:

| Surface | Route | What to set |
|---|---|---|
| Cause story | dashboard → cause story | The "why" — drives the microsite's Our Cause section and sponsor outreach |
| Tournament Goals | `/goals` | The five numbers: players, sponsorship $, donation items, marketing reach, volunteer roles. Progress is read **live** — never updated by hand |
| Your Team | `/team` | Assign committee + day-of roles from the built-in library; each gets a shareable link and reminders |
| Sponsorships | `/sponsors` | Tiers and prospects; the pipeline tracks contacted → replied → verbal → paid |
| F&B Calculator | `/fb` | Weather-adjusted food/drink quantities once you have a headcount |
| Microsite | `/dashboard/microsite` | Public page: URL slug, colors, contact email, location, socials |

Goals, sponsorship "committed", and the dashboard money tiles all use the **same
definitions** — a verbal handshake counts toward committed, entry fees count as
raised once paid. The numbers agree across every surface by construction.

## Pre-flight checklist — run before you tell anyone the link

- [ ] `GET https://www.tourneycoach.com/api/health` returns `status` **ok** or
      **degraded** (never **down** — down means a migration is missing and it
      names which).
- [ ] Microsite loads at `/microsite/<slug>` and shows the **right date and
      shotgun time** (not a day early, not 8:00 if you set something else).
- [ ] A test registration through the public page reaches payment (Adyen is
      live) — or returns a clean 201 via the API.
- [ ] "Foursomes claimed" on the microsite matches reality (not 0 when you have
      registrations).
- [ ] Tournament Goals shows your five targets, all reading live.
- [ ] At least the day-of critical roles (Registration Lead, Kitchen Liaison)
      have a person and a working contact.
- [ ] Entry-fee math on the register page matches what you set (per-foursome =
      4 × per-player, plus the 2.5% new-member fee).

## What still needs a real account (not blockers for a beta, but know them)

- **SMS is off.** Twilio is unconfigured, so volunteer invites/reminders and
  day-of triggers fall back to email. Every SMS path degrades gracefully; none
  errors. Set `TWILIO_*` + register A2P 10DLC to enable.
- **Email open tracking is off.** The SendGrid Event Webhook is not delivering
  events, so the guidance engine treats every email older than 48h as unopened
  and may over-escalate volunteers to SMS (which currently means email). Point
  the Event Webhook at `/api/webhooks/sendgrid` with open+click enabled. The
  health check flags this.
- **No tournament timezone.** Times are stored and shown as wall-clock ("8:00
  AM") carried as UTC end to end — correct on the server, but a reminder
  scheduled "30 min before" fires against UTC. Fine for a single beta whose
  organizer reads the times as written; the real fix is a timezone column.

## Migrations this depends on

All of 046–050 should be applied (`/api/health` names any that are missing).
**050** (tournament status timestamps) is new for Day 33 — the publish flow
works without it (the handler tolerates the missing columns), but applying it
lets the platform record when each tournament went public.
