# AI Coaching Topics

The coach answers in two modes:

- **Demo Mode** — deterministic scripted answers in `SCRIPTS` in
  [`app/coach/page.tsx`](../app/coach/page.tsx). No API key required. This is what
  runs today and what the topic list below maps to.
- **Live AI** — Claude via [`app/api/coach/chat/route.ts`](../app/api/coach/chat/route.ts),
  gated on `ANTHROPIC_API_KEY`. The system prompt there mirrors these topics and the
  escalation rules.

## How the pieces fit together

| Piece | Where | Notes |
|---|---|---|
| Scripted topic answers | `SCRIPTS` in `app/coach/page.tsx` | `{ answer, spoken, followups }` per key |
| Phrasing aliases | `SCRIPT_ALIASES` in `app/coach/page.tsx` | maps common phrasings → canonical key |
| Default suggestion chips | `FAQ_CHIPS` | what shows before any follow-ups |
| Proactive nudges | `computeNudges()` | state-driven prompts, max 2, dismissible |
| Human escalation | `"i need to talk to a human"` script + "Talk to a human" button | points to support@tourneycoach.com |

## Adding a new topic

1. Add an entry to `SCRIPTS` with a lowercase, punctuation-free key
   (e.g. `"how do i handle weather"`).
2. Give it `answer`, a shorter `spoken` variant, and 3 `followups` that are
   themselves valid script keys/questions.
3. Add natural phrasings to `SCRIPT_ALIASES` so variants resolve.
4. If it's a headline decision, add it to `FAQ_CHIPS`.
5. Mirror the guidance in the live system prompt in `app/api/coach/chat/route.ts`.

Every follow-up chip must resolve to a real script — verify with the parity check
(see the Day 12/13 test notes) so there are no dead-end chips.

## Current topic modules

### Day 13 core topics (first-time-organizer decisions)
- `how do i price registration` — what to charge per player and why
- `what should sponsorship packages look like` — tier ladder and benefits
- `how do i find volunteers` — how many, warm sources, roles
- `how do i get vendor donations` — in-kind asks tied to recognition
- `what does a successful year 1 look like` — realistic goals beyond dollars

### Sponsorship (Day 14–15)
- `how do i get sponsors`, `what packages should i offer`, `who should i ask to sponsor`,
  `how do i write a sponsor email`, `a sponsor hasn't replied`, `how do sponsors pay`,
  `how do i recognize sponsors`, `what is tourneycircle of excellence`

### Fundraising & pricing
- `what should i charge`, `how much will we raise`, `what expenses should i plan for`

### Field & registration
- `how do i fill my field`, `how do i register`, `how does tourneycircle work`,
  `how much does it cost to register on tourneycoach`

### Day-of & product
- `how does scoring work`, `how does day-of scoring work`, `how does the leaderboard work`,
  `what is the kitchen notification`

### Escalation
- `i need to talk to a human` — support@tourneycoach.com; legal/tax/insurance → licensed professional

## Proactive trigger rules (in `computeNudges`)

Surfaces at most two gentle, dismissible nudges based on tournament state. Order of priority:

1. **Cause story not written** → offer to talk through what makes a great one
2. **No sponsorship packages built** → offer to show a good package menu
3. **≤45 days out and <50% of sponsorships sold** → offer outreach strategy
4. **≤45 days out and <50% of the field filled** → offer field-filling help
5. **≥75% full and nothing else pressing** → positive nudge toward day-of logistics

Tone rule: supportive and optional, never pushy. Every nudge has a "Not now" dismiss and
only shows while the conversation is fresh (before the organizer has asked anything).
