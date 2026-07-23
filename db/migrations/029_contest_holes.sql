-- Day 22 — contest holes (Module 14 scorecard indicators + TV status).
--
-- Hole-in-one / closest-to-pin / long-drive contests are configured per
-- tournament on specific holes, shown as indicators on the mobile scorecard
-- and as a status line on the TV leaderboard. A winner is recorded by the
-- organizer once the contest is decided (null = "no winner yet").
create table if not exists contest_holes (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  contest_type text not null check (contest_type in ('hole_in_one', 'closest_to_pin', 'long_drive')),
  prize text,
  winner_registration_id uuid references registrations(id) on delete set null,
  winner_name text,        -- free-text winner (a specific player, not always a whole team)
  winner_detail text,      -- e.g. "12 ft 4 in", "back tee"
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tournament_id, hole_number, contest_type)
);

create index if not exists contest_holes_tournament_idx on contest_holes (tournament_id, hole_number);

-- Same posture as scoring tables: service-role only. Public reads come through
-- the board API (which draft-gates), organizer writes through an owner-checked
-- API route.
alter table contest_holes enable row level security;
revoke all on contest_holes from anon, authenticated;
