-- Day 29 — Communication Engine & Personalized Guidance Engine (Phase F).
--
-- Two systems, one migration, because the guidance profile decides what the
-- communication engine sends: the profile picks the depth, cadence and channel,
-- and the engine delivers through them and logs the result. Splitting them
-- would put a foreign key across two migrations for no benefit.
--
-- NOTE on guidance_profiles: that table already exists and is ORGANIZER-scoped
-- (tournaments_run, avg_field_size, avg_raise_cents — the organizer coaching
-- concept). The patent-candidate Concept E mechanism is per-VOLUNTEER and gets
-- its own table below rather than mutating an existing concept into a
-- different shape. Nothing here touches guidance_profiles.

-- ── Communication ledger ────────────────────────────────────────────────────
-- communication_log was spec-pasted on Day 2 with six columns (recipient_email,
-- channel, subject, status, sent_at). It becomes the unified send ledger for
-- every channel: what went out, to whom, through what, and what happened.
alter table public.communication_log
  add column if not exists volunteer_id    uuid references public.volunteers(id) on delete set null,
  add column if not exists kind            text not null default 'ad_hoc',
  add column if not exists body            text,
  add column if not exists recipient_phone text,
  -- Cadence claim key, e.g. 'pre_event:1440' or 'day_of:kitchen_fired'.
  add column if not exists offset_key      text,
  -- Provider id: Twilio SID, SendGrid message id, push endpoint hash.
  add column if not exists message_id      text,
  add column if not exists error           text,
  -- In-app messages are "delivered" when written and "read" when opened.
  add column if not exists read_at         timestamptz,
  add column if not exists meta            jsonb,
  add column if not exists created_at      timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'communication_log_kind_chk') then
    alter table public.communication_log add constraint communication_log_kind_chk
      check (kind in ('reminder', 'guidance', 'broadcast', 'reply', 'escalation', 'invite', 'ad_hoc'));
  end if;
end $$;

-- Claim-before-send, same shape as volunteer_reminders (040) and the donation
-- follow-up log (041): the ledger row is inserted BEFORE the provider call, so
-- two concurrent cadence runs cannot both text the same volunteer the same
-- reminder. The unique index is what makes the second insert fail.
create unique index if not exists communication_log_cadence_claim
  on public.communication_log (volunteer_id, offset_key)
  where kind = 'reminder' and offset_key is not null and volunteer_id is not null;

create index if not exists communication_log_volunteer_idx
  on public.communication_log (volunteer_id, created_at desc);
create index if not exists communication_log_tournament_kind_idx
  on public.communication_log (tournament_id, kind, created_at desc);

-- ── Concept E: per-volunteer guidance profiles ──────────────────────────────
-- The five signals are snapshotted into `signals` at compute time so a profile
-- is auditable: you can always see WHY someone got minimal SMS nudges while
-- someone else got detailed emails.
create table if not exists public.volunteer_guidance_profiles (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references public.tournaments(id) on delete cascade,
  volunteer_id     uuid not null references public.volunteers(id) on delete cascade,
  experience_level text not null default 'first_timer'
    check (experience_level in ('first_timer', 'returning', 'veteran')),
  depth            text not null default 'detailed'
    check (depth in ('detailed', 'standard', 'minimal')),
  cadence          text not null default 'full'
    check (cadence in ('full', 'standard', 'light')),
  channel          text not null default 'email'
    check (channel in ('sms', 'email', 'push', 'in_app')),
  signals          jsonb not null default '{}'::jsonb,
  computed_at      timestamptz not null default now(),
  recompute_reason text,
  unique (tournament_id, volunteer_id)
);

-- Engagement signals feed recomputation. Append-only.
create table if not exists public.guidance_events (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  volunteer_id  uuid not null references public.volunteers(id) on delete cascade,
  kind          text not null
    check (kind in ('portal_viewed', 'task_completed', 'task_uncompleted', 'message_sent',
                    'invite_responded', 'reminder_sent', 'feedback')),
  payload       jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists guidance_events_volunteer_idx
  on public.guidance_events (volunteer_id, created_at desc);

-- Task completion — the strongest performance signal, and until now nothing
-- recorded it: task status was derived purely from time. A volunteer ticking
-- off "Stock the cart" is both a progress fact and a guidance signal.
create table if not exists public.volunteer_task_completions (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references public.tournaments(id) on delete cascade,
  assignment_id    uuid not null references public.tournament_volunteer_assignments(id) on delete cascade,
  task_template_id uuid not null references public.task_templates(id) on delete cascade,
  completed_at     timestamptz not null default now(),
  -- Computed against the task's due time at completion, so "late" survives
  -- the event date being moved afterwards.
  completed_late   boolean not null default false,
  unique (assignment_id, task_template_id)
);
create index if not exists volunteer_task_completions_tournament_idx
  on public.volunteer_task_completions (tournament_id);

-- ── Two-way messaging ───────────────────────────────────────────────────────
-- One thread per volunteer per tournament. The volunteer writes with their
-- invite token; the organizer answers from the dashboard; 'platform' audience
-- escalates beyond the tournament.
create table if not exists public.volunteer_messages (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  volunteer_id  uuid not null references public.volunteers(id) on delete cascade,
  direction     text not null check (direction in ('from_volunteer', 'to_volunteer')),
  audience      text not null default 'organizer'
    check (audience in ('lead', 'organizer', 'platform')),
  sender_name   text,
  body          text not null,
  escalated_at  timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists volunteer_messages_thread_idx
  on public.volunteer_messages (tournament_id, volunteer_id, created_at);
create index if not exists volunteer_messages_unread_idx
  on public.volunteer_messages (tournament_id, read_at)
  where direction = 'from_volunteer';

-- ── Push subscriptions ──────────────────────────────────────────────────────
-- Web Push. The endpoint is the identity — one row per browser registration.
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid references public.tournaments(id) on delete cascade,
  volunteer_id  uuid references public.volunteers(id) on delete cascade,
  user_id       uuid,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz not null default now()
);

-- ── Access ──────────────────────────────────────────────────────────────────
-- Same posture as 040/041: service-role only, reached through owner-checked or
-- token-checked API routes. The browser's anon key touches none of this.
do $$
declare t text;
begin
  foreach t in array array['volunteer_guidance_profiles', 'guidance_events',
    'volunteer_task_completions', 'volunteer_messages', 'push_subscriptions',
    'communication_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Verification: expect 5 new tables and 10 new communication_log columns.
select
  (select count(*) from information_schema.tables
     where table_schema = 'public'
       and table_name in ('volunteer_guidance_profiles', 'guidance_events',
         'volunteer_task_completions', 'volunteer_messages', 'push_subscriptions')) as new_tables,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'communication_log'
       and column_name in ('volunteer_id', 'kind', 'body', 'recipient_phone', 'offset_key',
         'message_id', 'error', 'read_at', 'meta', 'created_at')) as comm_columns;
