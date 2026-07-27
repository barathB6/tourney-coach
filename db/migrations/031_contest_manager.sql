-- Day 23 — Contest Hole Manager (Module 13).
--
-- Expands the Day 22 contest_holes table from a thin "winner marker" into a
-- full contest system: four contest types, hole-in-one insurance + witnesses,
-- sponsor attribution, per-player leaderboard submissions (closest-to-pin,
-- long-drive), and a paid putting contest with a pot + top-3 payout.
--
-- Posture unchanged from 029: service-role only. Public reads come through the
-- draft-gated board API; organizer writes through owner-checked routes.

-- ── contest_holes: new type + relaxed hole + richer config ──

-- Putting happens on the practice green, not a numbered hole — allow a null
-- hole_number for it.
alter table contest_holes alter column hole_number drop not null;
alter table contest_holes drop constraint if exists contest_holes_hole_number_check;
alter table contest_holes add constraint contest_holes_hole_number_check
  check (hole_number is null or hole_number between 1 and 18);

-- Add the fourth contest type.
alter table contest_holes drop constraint if exists contest_holes_contest_type_check;
alter table contest_holes add constraint contest_holes_contest_type_check
  check (contest_type in ('hole_in_one', 'closest_to_pin', 'long_drive', 'putting'));

alter table contest_holes add column if not exists sponsor text;
alter table contest_holes add column if not exists notes text;
alter table contest_holes add column if not exists location_label text;   -- e.g. "Practice green · pre-round"

-- Hole-in-one prize value + insurance tracking.
alter table contest_holes add column if not exists prize_value_cents bigint;
alter table contest_holes add column if not exists insurance_status text default 'none';  -- none | quoted | paid
alter table contest_holes add column if not exists insurance_cost_cents bigint;
alter table contest_holes add column if not exists insurer text;

-- Hole-in-one witnesses: [{ name, confirmed }]. Verification stamps.
alter table contest_holes add column if not exists witnesses jsonb not null default '[]'::jsonb;
alter table contest_holes add column if not exists verified_at timestamptz;
alter table contest_holes add column if not exists verification_notes text;

-- Long-drive category split.
alter table contest_holes add column if not exists category_mode text default 'open';  -- open | by_gender | by_age

-- Putting contest economics + multi-winner payout.
alter table contest_holes add column if not exists entry_fee_cents bigint;
alter table contest_holes add column if not exists payout_split text;                    -- e.g. "60/30/10"
alter table contest_holes add column if not exists winners jsonb not null default '[]'::jsonb;  -- [{ name, detail, place }]

-- Guardrails (added separately so re-runs on an already-migrated table succeed).
do $$ begin
  alter table contest_holes add constraint contest_holes_insurance_status_check
    check (insurance_status in ('none', 'quoted', 'paid'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table contest_holes add constraint contest_holes_category_mode_check
    check (category_mode in ('open', 'by_gender', 'by_age'));
exception when duplicate_object then null; end $$;

-- ── contest_entries: per-player leaderboard submissions ──
--
-- Closest-to-pin and long-drive collect a measurement per player as the round
-- runs. value_inches is a normalized distance (lower wins for closest-to-pin,
-- higher wins for long-drive — direction lives in the app, not the schema).
-- category groups long-drive entries when category_mode != 'open'.
create table if not exists contest_entries (
  id uuid primary key default gen_random_uuid(),
  contest_hole_id uuid not null references contest_holes(id) on delete cascade,
  registration_id uuid references registrations(id) on delete set null,
  player_name text not null,
  category text,
  value_inches numeric,
  raw_label text,
  created_at timestamptz not null default now()
);

create index if not exists contest_entries_contest_idx on contest_entries (contest_hole_id, value_inches);

alter table contest_entries enable row level security;
revoke all on contest_entries from anon, authenticated;
