-- Day 25 — Phase E privacy hardening, from the penetration audit of the
-- TourneyCircle aggregate layer (patent Concept B).
--
-- Finding: player_profiles is deliberately readable by an organizer for their
-- own registrants (migration 004's RLS policy, and it's whitelisted out of
-- 025's lockdown sweep). Name/email/phone of their OWN registrants is data the
-- organizer collected themselves, so that part is fine.
--
-- What is NOT fine is `tournament_ids` and `registration_count`: those describe
-- the player's participation across OTHER organizers' tournaments. That is the
-- cross-tournament network — the thing the organizer never contributed and must
-- never see. RLS filters rows, not columns, so the row policy alone can't
-- withhold them; column-level grants can.
--
-- Nothing in the app reads either column from the browser (verified repo-wide),
-- so this is a pure removal of an unused, leaky capability.

revoke select on public.player_profiles from anon, authenticated;

grant select (id, email, name, phone, first_registration_id, created_at, updated_at)
  on public.player_profiles to authenticated;

-- anon gets nothing: the registration form's returning-member check runs
-- server-side through /api/players/lookup, never from the browser.


-- ── Opaque visit tokens ─────────────────────────────────────────────────────
-- Finding: the notification link carried the raw player_profile_id as ?tc=, and
-- /api/circle/visit accepted it from anyone. An organizer can read their own
-- registrants' player_profile_id, so they could forge a "visit" for a known
-- person and then watch the matched count drop by one — confirming that named
-- individual is a TourneyCircle member living inside the radius. A disclosure
-- threshold doesn't stop that: both counts are large, it's the CHANGE the
-- organizer caused that leaks.
--
-- So the link carries a token that only the recipient of that notification
-- holds, and the visit route resolves the player from the token instead of
-- trusting a caller-supplied id. Prep for Module 25 (Phase 1.5), which is what
-- will actually put these tokens into emails.
alter table public.tourneycircle_sends
  add column if not exists visit_token uuid not null default gen_random_uuid();

create unique index if not exists tc_sends_visit_token_idx
  on public.tourneycircle_sends (visit_token);
