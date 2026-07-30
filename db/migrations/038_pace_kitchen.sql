-- Module 9 — Pace-of-Play Tracker + Kitchen Notification.
--
-- One row per kitchen notification actually sent. This table IS the
-- idempotency guard: the auto-fire check runs on every score submission (and
-- again from the cron route), so without a durable "already sent" record a busy
-- back nine would text the chef a dozen times. The unique index does the
-- enforcing rather than application logic, because two score submissions can
-- land in the same instant on different serverless instances.
--
-- Safe to re-run.

create table if not exists public.kitchen_notifications (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  -- Where it went and what it said, kept verbatim: if a chef says they never
  -- got it, the organizer needs to see exactly what we sent and when.
  to_phone text not null,
  message text not null,
  -- 'sent' | 'failed' — a failed attempt is still recorded so we don't spin,
  -- and so the organizer can see it didn't get through.
  status text not null default 'sent',
  provider_sid text,
  error text,
  -- Snapshot of the estimate at fire time, for after-the-fact review.
  minutes_to_finish numeric,
  holes_in_play integer[] not null default '{}',
  groups_still_out integer not null default 0,
  created_at timestamptz not null default now()
);

-- Added separately rather than inline so re-running can't trip over an
-- already-present constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kitchen_notifications_status_check'
      and conrelid = 'public.kitchen_notifications'::regclass
  ) then
    alter table public.kitchen_notifications
      add constraint kitchen_notifications_status_check
      check (status in ('sent', 'failed'));
  end if;
end $$;

-- At most ONE successful notification per tournament, ever. Partial, so a
-- failed attempt doesn't occupy the slot and can be retried on the next score.
create unique index if not exists kitchen_notifications_one_per_tournament
  on public.kitchen_notifications (tournament_id)
  where status = 'sent';

create index if not exists kitchen_notifications_tournament_idx
  on public.kitchen_notifications (tournament_id, created_at desc);

-- Players and organizers never touch this table directly: the pace API reads it
-- after an ownership check, and the auto-fire writes it with the service role.
alter table public.kitchen_notifications enable row level security;
revoke all on public.kitchen_notifications from anon, authenticated;

-- Explicit, rather than relying on this project's default privileges. If
-- service_role has no grant, every read fails as PGRST205 "could not find the
-- table in the schema cache" — which looks like the table was never created and
-- sends you hunting in the wrong place.
grant all on public.kitchen_notifications to service_role;

-- PostgREST caches the schema and will keep reporting PGRST205 for a table it
-- has not re-read yet. Supabase usually reloads on DDL, but not always.
notify pgrst, 'reload schema';

-- Verification. Should return one row: the table, RLS on, and service_role
-- holding privileges. If this comes back empty, the create above did not run.
select
  c.relname                                                as table_name,
  c.relrowsecurity                                         as rls_enabled,
  has_table_privilege('service_role', c.oid, 'SELECT')     as service_role_can_read,
  has_table_privilege('service_role', c.oid, 'INSERT')     as service_role_can_write,
  (select count(*) from pg_indexes
    where schemaname = 'public' and tablename = 'kitchen_notifications') as index_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'kitchen_notifications';
