-- Day 21 — Live Scoring Backend (Module 14).
--
-- score_submissions (026) already stores every score with its GPS-labeling
-- state, append-only, latest-per-(registration,hole) wins. This adds the
-- organizer correction audit trail: corrections append a NEW score row (so
-- history is never rewritten) and record who changed what and why here.
create table if not exists score_corrections (
  id uuid primary key default gen_random_uuid(),
  score_submission_id uuid not null references score_submissions(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  registration_id uuid not null references registrations(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  old_strokes integer,           -- null when the team had no prior score for the hole
  new_strokes integer not null check (new_strokes between 1 and 20),
  reason text,
  corrected_by uuid not null references auth.users(id),
  corrected_at timestamptz not null default now()
);

create index if not exists score_corrections_tournament_idx
  on score_corrections (tournament_id, corrected_at desc);

-- Same posture as every scoring/GPS table: service-role only. All reads and
-- writes go through API routes that verify organizer ownership themselves.
alter table score_corrections enable row level security;
revoke all on score_corrections from anon, authenticated;
