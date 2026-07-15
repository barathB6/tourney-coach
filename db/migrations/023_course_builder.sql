-- Golf Pro Course Builder (Day 17, Module 12).
--
-- courses already exists (name/address/city/state/zip/total_holes/par_total)
-- from earlier seed data (e.g. Pebble Beach) but has no hole-by-hole detail,
-- no tee data, no contact/charity metadata, and no ownership. This adds all
-- of that plus a course_holes table carrying par/handicap/yardage per tee
-- and a structural GPS attachment point that Day 18's GPS ingestion will
-- populate (left null here — no live GPS pipeline exists yet).

alter table courses add column if not exists slope integer;
alter table courses add column if not exists tees jsonb not null default '["black","blue","white","gold","red"]'::jsonb;
alter table courses add column if not exists contact_name text;
alter table courses add column if not exists contact_email text;
alter table courses add column if not exists contact_phone text;
alter table courses add column if not exists charity_policy text;
alter table courses add column if not exists organizer_id uuid references auth.users(id);
alter table courses add column if not exists profile_status text not null default 'draft'
  check (profile_status in ('draft', 'complete'));

create table if not exists course_holes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  par integer check (par in (3, 4, 5)),
  handicap integer check (handicap between 1 and 18),
  description text,
  tee_yardages jsonb not null default '{}'::jsonb,
  -- Placeholder structural identifier for Day 18's GPS ingestion: tee/fairway/
  -- green positions land here once player-phone data starts collecting.
  gps_status jsonb not null default '{"tee": null, "fairway": null, "green": null}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, hole_number)
);

alter table course_holes enable row level security;

-- Organizer picks which of the course's tees a given tournament plays from.
alter table tournaments add column if not exists selected_tees jsonb;

-- courses: shared library (existing seed rows like Pebble Beach have no
-- owner) — anyone authenticated can read and pick a course when setting up
-- a tournament, but only the pro who created a profile can edit it.
drop policy if exists "courses are readable by authenticated users" on courses;
create policy "courses are readable by authenticated users"
  on courses for select
  to authenticated
  using (true);

drop policy if exists "authenticated users can create course profiles" on courses;
create policy "authenticated users can create course profiles"
  on courses for insert
  to authenticated
  with check (organizer_id = auth.uid());

drop policy if exists "owner can update own course profile" on courses;
create policy "owner can update own course profile"
  on courses for update
  to authenticated
  using (organizer_id = auth.uid())
  with check (organizer_id = auth.uid());

drop policy if exists "course holes are readable by authenticated users" on course_holes;
create policy "course holes are readable by authenticated users"
  on course_holes for select
  to authenticated
  using (true);

drop policy if exists "owner can write own course holes" on course_holes;
create policy "owner can write own course holes"
  on course_holes for insert
  to authenticated
  with check (course_id in (select id from courses where organizer_id = auth.uid()));

drop policy if exists "owner can update own course holes" on course_holes;
create policy "owner can update own course holes"
  on course_holes for update
  to authenticated
  using (course_id in (select id from courses where organizer_id = auth.uid()))
  with check (course_id in (select id from courses where organizer_id = auth.uid()));
