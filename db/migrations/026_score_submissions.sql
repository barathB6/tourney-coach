-- Score submissions (Day 18 completion): the write that fires the patent's
-- score-submission-as-GPS-labeling trigger. A submission's contemporaneous
-- GPS points get tagged as the green for that hole by
-- lib/gps/labelGreen.ts, called from app/api/gps/score/route.ts the moment
-- a score lands. green_labeled_points records how many points that
-- submission labeled — an auditable per-event trace of the inventive
-- mechanism actually firing.
--
-- NOTE: a spec-pasted `scores` table already exists in this database
-- (created outside migrations, shape unverified, locked down by 025). This
-- table is deliberately separate so the pipeline depends only on
-- migration-managed schema. Service-role only, like the rest of the GPS
-- pipeline: players have no auth session, so RLS is enabled with no
-- policies and client grants are revoked.

create table if not exists score_submissions (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete cascade,
  course_id uuid references courses(id) on delete cascade,
  device_id uuid references gps_devices(id) on delete set null,
  hole_number integer not null check (hole_number between 1 and 18),
  strokes integer not null check (strokes between 1 and 20),
  green_labeled_points integer not null default 0,
  submitted_at timestamptz not null default now()
);

create index if not exists score_submissions_lookup_idx
  on score_submissions (tournament_id, hole_number);

alter table score_submissions enable row level security;
revoke all on table score_submissions from anon, authenticated;
