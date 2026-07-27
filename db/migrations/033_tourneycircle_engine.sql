-- Day 24 — TourneyCircle Notification Engine (Module 10) behavioral tracking.
--
-- Two private, per-player logs that power the engine's suppression rules. Same
-- privacy posture as 032: service-role only; organizers never read rows, only
-- the aggregate counts the send/count APIs derive.

-- Registration-page visits — behavioral suppression: if a player already looked
-- at a tournament's registration page, don't notify them about it.
create table if not exists tourneycircle_visits (
  id uuid primary key default gen_random_uuid(),
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  visited_at timestamptz not null default now(),
  unique (player_profile_id, tournament_id)
);
alter table tourneycircle_visits enable row level security;
revoke all on tourneycircle_visits from anon, authenticated;

-- Per-player send log — cadence enforcement: minimum days between notifications
-- to the same player (their cadence_days, default 10, range 5–21).
create table if not exists tourneycircle_sends (
  id uuid primary key default gen_random_uuid(),
  player_profile_id uuid not null references player_profiles(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  notification_id uuid references tourneycircle_notifications(id) on delete set null,
  sent_at timestamptz not null default now()
);
create index if not exists tc_sends_player_idx on tourneycircle_sends (player_profile_id, sent_at desc);
alter table tourneycircle_sends enable row level security;
revoke all on tourneycircle_sends from anon, authenticated;
