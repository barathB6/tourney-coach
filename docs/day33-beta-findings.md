# Day 33 — what the beta dry run exposed

A fresh organizer account walked the real product flow — sign in, wizard, publish,
configure, view as a player. The point of a dry run is to find what only real use
finds. It found one blocker and several smaller things.

## Blocker (fixed)

**No tournament could ever be published.** The wizard's final button says
"Publish Tournament" but created a `draft` and stopped, and no publish control
existed anywhere in the product. A draft microsite 404s and registration is
refused, so every tournament was born un-shareable — 16 of 18 in the database
were stuck in draft. This alone made the beta impossible.

Root cause was two layers deep: no UI ever called the status-transition
endpoint, AND that endpoint writes `published_at`/`live_at`/`completed_at`
columns that were never migrated, so the first real transition would have 500'd
anyway. Both fixed (commit `31ae3e7`, migration 050): the wizard now publishes,
the microsite editor has a publish/unpublish control, and the handler tolerates
the missing columns so publish works with or without the migration.

## Smaller findings

- **Sign-in is Google-only** — no email/password. Not a bug, but a hard gate: a
  beta organizer without a Google account cannot onboard at all. This is the top
  onboarding backlog item.
- **Course dropdown showed test cruft** — a course literally named "d", a "SAFE
  TO DELETE" fixture, a duplicate Beau Chene. Cleaned. Worth a periodic sweep, or
  a flag to hide non-production courses.
- **The `e2e-phase-e` purge helper recursed infinitely** — a self-referential
  `say` from a Day 31 refactor. Fixed. Not user-facing, but it blocked cleanup.

## Confirmed working (via the real flow, not scripts)

- Wizard all six steps, autosave/resume, derived pricing ($125/player →
  $500/foursome → $16,000 projected).
- Publish → microsite live at the right date and 8:00 AM shotgun → registration
  returns 201 (was 409 while draft).
- Dashboard money tiles, Tournament Goals (all five, live), the game-plan
  "YOU'RE HERE" marker advancing as steps complete.
- Player microsite and volunteer views render correctly on mobile.

## Reference beta

**Northshore Charity Golf Classic** — Sep 19 2026, Beau Chene Country Club,
128-player double shotgun at 8:00 AM, $125/player, $50k goal, published, with a
starter committee and three sponsorship tiers. Live at
`/microsite/northshore-charity-golf-classic`. This is a real configured
tournament, kept as the worked example the runbook points to.
