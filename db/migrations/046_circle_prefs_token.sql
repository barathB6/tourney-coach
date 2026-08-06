-- Day 31 — TourneyCircle: a credential the organizer does not hold.
--
-- The opt-in/preferences API identified a player by their REGISTRATION ID.
-- That id is the round-link credential — fine for scoring, fatal here, because
-- the organizer sees every registration id of their own event on the
-- registrations dashboard. Anyone holding one could read back that named
-- player's TourneyCircle membership, radius and cause preferences, and
-- overwrite their home location. Repeated over a roster it reconstructs the
-- private member list, which is precisely what MIN_DISCLOSABLE_COUNT exists to
-- prevent.
--
-- prefs_token is the player's own secret. It never appears in an API response
-- keyed by a registration id, and it is the ONLY key that reads a member row.
alter table tourneycircle_members
  add column if not exists prefs_token uuid not null default gen_random_uuid();

create unique index if not exists tc_members_prefs_token_idx
  on tourneycircle_members (prefs_token);
