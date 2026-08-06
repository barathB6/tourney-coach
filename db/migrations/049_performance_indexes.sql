-- Day 32 — indexes for the queries the platform actually runs hottest.
--
-- Not a shotgun. Each one below backs a specific filter that appears on a page
-- load, a cron sweep, or the registration path, and that currently has either
-- no index or an index on only the first of two columns (which still means a
-- filter-then-scan over every row for that tournament).

-- The public registration page's "spots remaining", and every capacity check.
-- registrations_tournament_id_idx covers tournament_id alone; the count always
-- adds payment_status, and refunded rows have to be excluded.
create index if not exists registrations_tournament_payment_idx
  on public.registrations (tournament_id, payment_status);

-- The volunteer roster: the team page, the cadence sweep, the day-of board and
-- the reminder claim all read assignments for one tournament filtered by
-- status. tva_tournament_idx stops at tournament_id.
create index if not exists tva_tournament_status_idx
  on public.tournament_volunteer_assignments (tournament_id, status);

-- Volunteer reuse on the team route (one person, three roles → one row) and
-- every join from an assignment back to a person. This table had no index at
-- all beyond its primary key.
create index if not exists volunteers_tournament_idx
  on public.volunteers (tournament_id);
create index if not exists volunteers_tournament_email_idx
  on public.volunteers (tournament_id, lower(email));

-- Sold-inventory counts on the sponsor marketplace run on every page load of
-- the public purchase page: status in (paid, invoiced, verbal) for one
-- tournament. idx_sponsors_tournament orders by created_at instead.
create index if not exists sponsors_tournament_status_idx
  on public.sponsors (tournament_id, status);

-- The invite token is the volunteer's credential and is looked up by itself on
-- every request from the volunteer app — six screens, polling.
create index if not exists tva_invite_token_idx
  on public.tournament_volunteer_assignments (invite_token);

-- The goals dashboard reads the whole communication_log for a tournament and
-- filters mirrors out in application code; this makes that read an index scan.
create index if not exists communication_log_tournament_channel_idx
  on public.communication_log (tournament_id, channel);

-- TourneyCircle reach: every radius calculation scans the member table. The
-- existing tc_members_loc_idx covers (home_lat, home_lng), which is what a
-- bounding-box prefilter needs — this adds the partial index so members with
-- no home location (unmatchable, and a growing share) are skipped outright.
create index if not exists tc_members_locatable_idx
  on public.tourneycircle_members (home_lat, home_lng)
  where home_lat is not null and home_lng is not null;
