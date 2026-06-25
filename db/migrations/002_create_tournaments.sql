-- Tournament status enum for the state machine: draft → published → live → completed
create type tournament_status as enum ('draft', 'published', 'live', 'completed');

-- Tournament format enum
create type tournament_format as enum ('scramble', 'best_ball', 'alternate_shot', 'stroke_play');

-- Max score rule enum
create type max_score_rule as enum ('par', 'double_bogey', 'none');

-- Start method enum
create type start_method as enum ('single', 'double', 'wave', 'tee_times');

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references auth.users(id) on delete cascade,

  -- basics (step 1)
  name text not null,
  organization text,
  event_date date not null,

  -- course (step 2)
  course_id uuid references public.courses(id),
  custom_course_name text,
  custom_course_city text,
  custom_course_state text,

  -- format (step 3)
  format tournament_format not null default 'scramble',
  team_size smallint not null default 4 check (team_size between 2 and 5),
  max_score_rule max_score_rule not null default 'par',

  -- start method (step 4)
  shotgun_type start_method not null default 'double',

  -- field & pricing (step 5)
  max_players smallint not null default 128 check (max_players > 0),
  entry_fee integer not null default 125 check (entry_fee >= 0),

  -- cause story (step 6)
  cause_what text,
  cause_who text,
  cause_why text,

  -- state machine
  status tournament_status not null default 'draft',
  published_at timestamptz,
  live_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- tournament name must be unique per organizer
  constraint unique_name_per_organizer unique (organizer_id, name)
);

-- Index for organizer lookups
create index idx_tournaments_organizer on public.tournaments(organizer_id);

-- Auto-update updated_at on row change
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_tournaments_updated_at
  before update on public.tournaments
  for each row execute function update_updated_at();

-- Row level security
alter table public.tournaments enable row level security;

-- Organizers can manage their own tournaments
create policy "Tournaments: organizer full access" on public.tournaments
  for all
  using (auth.uid() = organizer_id)
  with check (auth.uid() = organizer_id);

-- Anyone can read published/live/completed tournaments
create policy "Tournaments: public read" on public.tournaments
  for select
  using (status in ('published', 'live', 'completed'));
