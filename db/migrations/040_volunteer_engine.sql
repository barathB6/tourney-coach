-- Day 27 — Volunteer Roles Engine: invitations, reminders, planning meetings.
--
-- The invite/confirm state lives on the ASSIGNMENT, not on the volunteer. One
-- person can hold "Course Liaison" in planning and "Kitchen Liaison" on the
-- day, and they might confirm one and decline the other — a single
-- confirmed_at on the volunteer row cannot express that.
--
-- Safe to re-run.

alter table public.tournament_volunteer_assignments
  -- Opaque per-assignment token. It is what a volunteer holds instead of a
  -- login: they have no account, so the link in their email IS the credential.
  -- Per-assignment (not per-volunteer) so a leaked link can only ever answer
  -- for the one role it was issued for.
  add column if not exists invite_token uuid not null default gen_random_uuid(),
  add column if not exists invited_at timestamptz,
  add column if not exists responded_at timestamptz,
  add column if not exists invite_channel text,
  add column if not exists invite_error text;

create unique index if not exists tva_invite_token_idx
  on public.tournament_volunteer_assignments (invite_token);

-- ── Reminders ───────────────────────────────────────────────────────────────
-- 7 days, 2 days, and 90 minutes before the role starts. One row per
-- (assignment, offset) actually sent — this table IS the idempotency guard, the
-- same shape as kitchen_notifications, because the sender runs on a schedule
-- and a volunteer being texted the same reminder four times is how you lose
-- volunteers.
create table if not exists public.volunteer_reminders (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.tournament_volunteer_assignments(id) on delete cascade,
  -- Minutes before role start this reminder represents: 10080 (7d), 2880 (2d), 90.
  offset_minutes integer not null,
  channel text not null check (channel in ('sms', 'email')),
  status text not null default 'sent' check (status in ('sent', 'failed')),
  message text,
  error text,
  created_at timestamptz not null default now()
);

create unique index if not exists volunteer_reminders_once
  on public.volunteer_reminders (assignment_id, offset_minutes)
  where status = 'sent';

create index if not exists volunteer_reminders_assignment_idx
  on public.volunteer_reminders (assignment_id);

-- ── Weekly planning meetings ────────────────────────────────────────────────
-- The committee's recurring rhythm during the 12–16 week planning phase.
create table if not exists public.planning_meetings (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  title text not null default 'Weekly planning meeting',
  scheduled_at timestamptz not null,
  -- Free-text agenda the organizer edits; the action items below are the
  -- structured part that actually needs chasing.
  agenda text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists planning_meetings_tournament_idx
  on public.planning_meetings (tournament_id, scheduled_at desc);

create table if not exists public.meeting_attendance (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.planning_meetings(id) on delete cascade,
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'attended', 'absent', 'excused')),
  created_at timestamptz not null default now()
);

create unique index if not exists meeting_attendance_once
  on public.meeting_attendance (meeting_id, volunteer_id);

create table if not exists public.meeting_action_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.planning_meetings(id) on delete cascade,
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  description text not null,
  -- Nullable: an action item can be logged before anyone owns it, and that
  -- unowned state is exactly what the next meeting needs to surface.
  owner_volunteer_id uuid references public.volunteers(id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists meeting_action_items_tournament_idx
  on public.meeting_action_items (tournament_id, completed_at);

-- ── Access ──────────────────────────────────────────────────────────────────
-- Same posture as the rest of the TOC (migration 025): the browser never reads
-- these directly. Organizer screens go through owner-checked API routes; the
-- volunteer confirm page goes through a token-checked route. service_role is
-- granted explicitly rather than relying on default privileges — that is what
-- made 038 look like it had silently done nothing.
do $$
declare t text;
begin
  foreach t in array array['volunteer_reminders', 'planning_meetings', 'meeting_attendance', 'meeting_action_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

grant all on public.tournament_volunteer_assignments, public.volunteers to service_role;

notify pgrst, 'reload schema';

-- Verification: expect four new tables and the invite columns present.
select
  (select count(*) from information_schema.tables
     where table_schema = 'public'
       and table_name in ('volunteer_reminders','planning_meetings','meeting_attendance','meeting_action_items')) as new_tables,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'tournament_volunteer_assignments'
       and column_name in ('invite_token','invited_at','responded_at','invite_channel','invite_error')) as invite_columns;
