# Consolidated polish feedback — every flow, walked as the user

Not a code review. This is what the platform is like to *use*, walked screen by
screen as each user type against a seeded tournament with real data — 11
foursomes, 5 sponsors at five different pipeline stages, 3 committee members, 3
vendor prospects. Empty states hide almost everything worth finding.

## What the walkthrough found and fixed

Recorded here because the pattern matters more than the individual bugs.

| What I saw | What it actually was |
|---|---|
| Dashboard said **Aug 26**; the tournament is Aug 27 | Ten browser-side renders of a DATE column through `new Date()`. Fixed for emails on Day 28, never carried to the pages. |
| **Raised so far $0 · Sponsors 0 · none yet** on a tournament with $15,940 banked | Three hardcoded literals, sitting beside a live "Field filled" tile — which is exactly what made them read as data rather than as placeholders |
| Microsite: **0 / 18 foursomes claimed** with 11 registered | My own migration 048 revoked the anon grant hours earlier; this counted with the anon key |
| Register page: **$600/team** on a $165 entry fee | Prices were platform-wide constants. The setup wizard collected an entry fee nothing read |
| Checkout quoted **$677.00**, card charged **$676.50** | Client rounded 2.5% in dollars, server in cents |
| **"1 confirmed sponsors"** — and the dashboard said "Sponsors 2" | Grammar, plus two vocabularies for one concept and two different status sets |

**The lesson for the remaining days:** every one of these is invisible to the
test suites, because each suite asserts on the *library* that computes a number,
not on the *string* a person reads. The E2E proved the goals dashboard returns
`sponsorshipCents: 350000`; nothing proved the dashboard tile beside it wasn't
the literal `$0`. Walk the screens.

## Remaining polish, by priority

### Worth doing before the beta

1. **Long tournament names break the mobile microsite header.** At 375px the
   title wraps to three lines and collides with the nav ("Our Cause", "Format",
   "Become a Sponsor"), which itself wraps. Needs a max-height with an ellipsis,
   or the nav collapsing to a menu below ~420px. Seen with a 33-character name;
   real names like "Sacred Heart Memorial Golf Classic" are 34.

2. **Two vocabularies for sponsor state.** The pipeline uses `verbal · awaiting
   check`, `Confirmed · invoiced`, `Confirmed · paid`; the tiles say
   "committed"; the goals dashboard says "Sponsorship raised". They now compute
   the same way, but an organizer still has to learn three names for one idea.
   Pick one — I'd use *committed* (verbal or better) and *collected* (money in
   hand) — and use it everywhere.

3. **The AI coach's demo panels are indistinguishable from live data.** The
   coach page ships a scripted leaderboard and a "Kitchen Notification Sent"
   card with a live countdown. In a walkthrough it took me a moment to work out
   which numbers were real. Either label them clearly as a demo or drive them
   from the selected tournament.

4. **"Days to tee off" appears three times with two different values.** The
   dashboard header says "3 weeks to tee off" (Stage 1) and "20 days to tee
   off" (Stage 2) on the same screen, and the microsite says "20 DAYS TO TEE
   OFF". Three weeks and 20 days are both true and reading them together is
   jarring. Use one unit.

### Worth doing, not urgent

5. **Empty states point nowhere.** "No confirmed sponsors yet — this fills in as
   sponsors pay" is honest but terminal. The good pattern is already on the
   goals page, where every row links to the surface that moves it; the goals
   page now does this for all five. Extend it.

6. **The day-of trigger list has no undo.** Six irreversible "Send" buttons in a
   row, on a phone, on the busiest morning of the year. They are correctly
   idempotent — a second tap is refused, proven by the concurrency suite — but a
   *wrong* tap (Kitchen fired at 8:40am) has no recovery beyond telling people
   to ignore it. A 10-second undo window would cost little.

7. **Add-on pricing is still platform-wide.** Mulligans $80 and putting contest
   $40 are constants, the same way entry fees were until today. Lower stakes,
   same shape: the organizer cannot price their own add-ons.

8. **Sponsor tier "Sold out" is silent about why.** Title shows "Sold out" with
   no indication that the one slot went to a *verbal* commitment rather than a
   paid one — which matters, because a verbal that falls through should
   reopen it.

### Deliberate, documented, not to be "fixed"

- **Suppressed counts read as 0 in the TourneyCircle breakdown.** That is the
  disclosure floor working. The page now says so where a bucket is withheld.
- **The volunteer app is deliberately plain.** Large type, no chrome, offline
  first. It looked unfinished next to the organizer surfaces until I opened it
  on a phone at 375px, which is the only context it will ever be used in.
- **Organizer sign-in is Google-only.** No email/password door. Fine as a
  product decision; worth knowing it means test accounts need session injection.

## Flows walked

Organizer — setup wizard (all 6 steps), dashboard, goals, team (planning /
day-of / meetings / inbox), sponsors, registrations, F&B planner, vendor
donations, TourneyCircle, day-of board.
Volunteer — token view at 375px, checklist, WHEN card, sign-in door.
Player — microsite, registration with live pricing and add-ons, sponsor
marketplace.
