-- Module 12 — delegated Golf Pro course access.
--
-- The organizer builds the tournament but the course's head pro owns the
-- ground truth for par/yardage/layout. This grants exactly one pro, by email,
-- edit rights on a single course profile — and while that grant is active the
-- organizer drops to read-only, so there's one authoritative editor and the
-- organizer still sees every edit live.
--
-- Auth here is deliberately NOT Supabase Auth: the pro is a course employee,
-- not a platform user, and should never need a Google account or a signup.
-- They get a link plus an issued password (golfCourseNameYear). Credentials
-- are verified server-side only, via the service-role client — same posture as
-- gps_devices: the table is unreachable from the browser entirely.
create table if not exists public.course_pro_access (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  email text not null,
  -- pbkdf2-sha256, stored as "salt:hash" hex. Node's built-in crypto — no new
  -- dependency, and the password is issued (not user-chosen) so it is never
  -- reused from elsewhere.
  password_hash text not null,
  -- opaque, unguessable path segment for /course/pro/<link_token>
  link_token text not null unique,
  -- set on successful login; the pro's browser holds this, not the password
  session_token text unique,
  session_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  revoked_at timestamptz
);

-- One active (non-revoked) grant per course: re-issuing replaces rather than
-- accumulating, so "who can edit this course" is never ambiguous.
create unique index if not exists course_pro_access_one_active
  on public.course_pro_access (course_id)
  where revoked_at is null;

create index if not exists course_pro_access_session
  on public.course_pro_access (session_token)
  where session_token is not null;

-- Credentials never leave the server. Every read/write goes through an API
-- route using the service-role key, which bypasses RLS.
alter table public.course_pro_access enable row level security;
revoke all on public.course_pro_access from anon, authenticated;
