-- Module 9 — Pace-of-Play Tracker + Kitchen Notification.
--
-- One row per kitchen notification actually sent. This table IS the
-- idempotency guard: the auto-fire check runs on every score submission (and
-- again on a cron), so without a durable "already sent" record a busy back
-- nine would text the chef a dozen times. The unique index does the enforcing
-- rather than application logic, because two score submissions can land in the
-- same instant on different serverless instances.
create table if not exists public.kitchen_notifications (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  -- Where it went and what it said, kept verbatim: if a chef says they never
  -- got it, the organizer needs to see exactly what we sent and when.
  to_phone text not null,
  message text not null,
  -- 'sent' | 'failed' — a failed attempt is still recorded so we don't spin,
  -- and so the organizer can see it didn't get through.
  status text not null default 'sent' check (status in ('sent', 'failed')),
  provider_sid text,
  error text,
  -- Snapshot of the estimate at fire time, for after-the-fact review.
  minutes_to_finish numeric,
  holes_in_play integer[] not null default '{}',
  groups_still_out integer not null default 0,
  created_at timestamptz not null default now()
);

-- At most ONE successful notification per tournament, ever. A partial index so
-- failed attempts don't occupy the slot and can be retried.
create unique index if not exists kitchen_notifications_one_per_tournament
  on public.kitchen_notifications (tournament_id)
  where status = 'sent';

create index if not exists kitchen_notifications_tournament_idx
  on public.kitchen_notifications (tournament_id, created_at desc);

-- Read through the owner-checked pace API only; writes are service-role.
alter table public.kitchen_notifications enable row level security;
revoke all on public.kitchen_notifications from anon, authenticated;
