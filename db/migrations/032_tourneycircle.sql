-- Day 24 — TourneyCircle Discovery & Opt-in (Module 22, Patent Concept B).
--
-- The patent-critical privacy architecture: a centralized participant store that
-- organizers can NEVER read at the row level — only aggregate counts, served by
-- a service-role API. RLS revokes anon + authenticated entirely on every table
-- here, so even a logged-in organizer's own JWT cannot select an individual
-- TourneyCircle member. Privacy is the trust mechanism that keeps players
-- opted in year after year.

-- ── Members: players who opted in at score-submission completion ──
create table if not exists tourneycircle_members (
  id uuid primary key default gen_random_uuid(),
  -- Cross-tournament identity: one membership per player profile.
  player_profile_id uuid references player_profiles(id) on delete cascade,
  email text,
  name text,
  -- Home location captured at opt-in (browser geolocation), for radius matching.
  home_lat numeric,
  home_lng numeric,
  radius_miles integer not null default 25 check (radius_miles in (15, 25, 35, 50)),
  cause_preferences text[] not null default '{}',
  cadence_days integer not null default 10 check (cadence_days between 5 and 21),
  member_type text not null default 'individual' check (member_type in ('individual', 'corporate', 'coe')),
  opted_in_at timestamptz not null default now(),
  source_tournament_id uuid references tournaments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_profile_id)
);
create index if not exists tc_members_loc_idx on tourneycircle_members (home_lat, home_lng);

alter table tourneycircle_members enable row level security;
revoke all on tourneycircle_members from anon, authenticated;

-- ── Declines: "not interested" — never prompt this player again ──
create table if not exists tourneycircle_declines (
  id uuid primary key default gen_random_uuid(),
  player_profile_id uuid references player_profiles(id) on delete cascade,
  declined_at timestamptz not null default now(),
  unique (player_profile_id)
);
alter table tourneycircle_declines enable row level security;
revoke all on tourneycircle_declines from anon, authenticated;

-- ── Notifications: an organizer's sent blast, aggregate outcomes only ──
-- Organizers read these through an owner-checked API (counts of reached /
-- clicked / registered) — never the underlying recipient list.
create table if not exists tourneycircle_notifications (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  organizer_id uuid not null,
  radius_miles integer not null,
  reached_count integer not null default 0,
  clicked_count integer not null default 0,
  registered_count integer not null default 0,
  cost_cents integer not null default 2900,
  sent_at timestamptz not null default now()
);
create index if not exists tc_notifications_tournament_idx on tourneycircle_notifications (tournament_id, sent_at desc);

alter table tourneycircle_notifications enable row level security;
revoke all on tourneycircle_notifications from anon, authenticated;
