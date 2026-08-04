-- Day 30 — event-driven day-of triggers + volunteer check-in positions.
--
-- Day 29 defined the day-of triggers as constants (DAY_OF_TRIGGERS) but nothing
-- recorded that one had actually fired. This table is that record, and it is
-- what makes the triggers idempotent: "awards starting" must notify the awards
-- crew exactly once, whether it was fired by the organizer's button, by the
-- pace tracker crossing a threshold, or by both within the same minute.

create table if not exists public.tournament_events (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  kind          text not null check (kind in (
                  'shotgun_started', 'last_group_teed', 'turn_reached',
                  'first_group_finished', 'kitchen_fired', 'last_group_in',
                  'awards_starting', 'tournament_complete')),
  fired_at      timestamptz not null default now(),
  -- 'organizer' when a human pressed the button, 'pace' when the tracker
  -- inferred it. Worth knowing when reconstructing a day afterwards.
  fired_by      text not null default 'organizer',
  notified      integer not null default 0,
  meta          jsonb,
  -- Each milestone happens once per tournament. This is the whole idempotency
  -- guarantee: a second fire attempt fails at the database, not in hope.
  unique (tournament_id, kind)
);

create index if not exists tournament_events_tournament_idx
  on public.tournament_events (tournament_id, fired_at desc);

-- Where a volunteer physically is on the day. Distinct from checked_in_at
-- (which is binary): a Beverage Cart Driver checks in once but moves all day.
alter table public.volunteers
  add column if not exists last_position       text,
  add column if not exists last_position_at    timestamptz;

-- ── Access ──────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['tournament_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Verification: expect 1 table and 2 volunteer columns.
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name = 'tournament_events') as new_table,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'volunteers'
       and column_name in ('last_position', 'last_position_at')) as position_columns;
