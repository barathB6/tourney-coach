-- Day 28 — F&B Calculator & Vendor Donation Engine (Phase F).
--
-- Both sub-systems land in one migration because they are one workflow: the
-- calculator's output quantities ARE the donation engine's ask. "10 cases of
-- beer" is what the calculator computed and what the email to the distributor
-- asks for; they must not drift apart.
--
-- All three tables here were spec-pasted into Supabase on Day 2 and locked
-- down by 025. They are still in that Day-2 shape:
--
--   fb_calculations       — revenue columns only (gross/net/per_player/
--                           sponsorship). Nothing about food, drink, headcount
--                           or weather. Unusable for a quantity calculator.
--   donation_prospects    — name/email/phone/company/tier. No vendor category,
--                           no outreach state, no follow-up counter.
--   donation_outreach_log — method/outcome/notes. No subject/body, so a sent
--                           email could not be shown back to the organizer.
--
-- We extend rather than drop: the revenue columns stay (nothing reads them
-- yet, but they are the spec's and dropping columns is not reversible).

-- ── F&B plan ────────────────────────────────────────────────────────────────
-- One plan per tournament. Inputs are stored alongside outputs on purpose:
-- a plan that says "216 waters" without recording that it assumed 78°F and
-- 72 players is not auditable, and the whole point of the headcount lock is
-- being able to say what the kitchen order was based on.
alter table public.fb_calculations
  add column if not exists player_count      integer,
  add column if not exists volunteer_count   integer not null default 0,
  add column if not exists guest_count       integer not null default 0,
  add column if not exists holes             integer not null default 18,
  -- Weather: temperature drives the whole model, so we record where the
  -- number came from. 'forecast' = real forecast for the event date,
  -- 'normals' = climate normals because the date is beyond forecast range,
  -- 'manual' = the organizer typed it.
  add column if not exists temperature_f     numeric(5,1),
  add column if not exists precip_chance     numeric(5,2),
  add column if not exists weather_source    text,
  add column if not exists weather_summary   text,
  add column if not exists weather_fetched_at timestamptz,
  -- Editable per-player baselines. Stored so a plan reproduces exactly even
  -- after we tune the shipped defaults.
  add column if not exists assumptions       jsonb,
  add column if not exists menu              jsonb,
  add column if not exists quantities        jsonb,
  add column if not exists prep_timeline     jsonb,
  -- Headcount lock: registrations keep moving until the last day, but the
  -- kitchen needs a number it can order against. Locking freezes the inputs.
  add column if not exists headcount_locked_at timestamptz,
  add column if not exists locked_player_count integer,
  add column if not exists handed_off_at    timestamptz,
  add column if not exists updated_at        timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fb_calculations_weather_source_chk') then
    alter table public.fb_calculations add constraint fb_calculations_weather_source_chk
      check (weather_source is null or weather_source in ('forecast', 'normals', 'manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fb_calculations_holes_chk') then
    alter table public.fb_calculations add constraint fb_calculations_holes_chk
      check (holes in (9, 18));
  end if;
end $$;

-- One plan per tournament — the calculator is a single screen, not a history.
create unique index if not exists fb_calculations_tournament_uniq
  on public.fb_calculations (tournament_id);

-- ── Course coordinates ──────────────────────────────────────────────────────
-- The weather lookup needs a point, and courses only carry a postal address.
-- Geocoding is cached here rather than re-resolved per calculation: the
-- address of a golf course does not move, and it keeps the calculator working
-- when the geocoder is down.
alter table public.courses
  add column if not exists latitude   numeric(9,6),
  add column if not exists longitude  numeric(9,6),
  add column if not exists geocoded_at timestamptz,
  add column if not exists geocode_label text;

-- ── Vendor donation prospects ───────────────────────────────────────────────
alter table public.donation_prospects
  -- The six categories the spec names. Category decides what we ask for,
  -- which is why it is not free text.
  add column if not exists category          text,
  add column if not exists contact_name      text,
  add column if not exists status            text not null default 'prospect',
  -- What the calculator says to ask this vendor for, frozen at draft time so
  -- the tracked record matches the email that actually went out.
  add column if not exists ask_summary       text,
  add column if not exists draft_subject     text,
  add column if not exists draft_body        text,
  add column if not exists draft_generated_at timestamptz,
  add column if not exists sent_at           timestamptz,
  add column if not exists follow_up_count   integer not null default 0,
  add column if not exists last_contact_at   timestamptz,
  add column if not exists opened_at         timestamptz,
  add column if not exists email_opens       integer not null default 0,
  add column if not exists responded_at      timestamptz,
  add column if not exists reply_snippet     text,
  add column if not exists committed_at      timestamptz,
  add column if not exists committed_value_cents integer,
  add column if not exists declined_at       timestamptz,
  add column if not exists updated_at        timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'donation_prospects_status_chk') then
    alter table public.donation_prospects add constraint donation_prospects_status_chk
      check (status in ('prospect', 'sent', 'opened', 'responded', 'committed', 'declined'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'donation_prospects_category_chk') then
    alter table public.donation_prospects add constraint donation_prospects_category_chk
      check (category is null or category in (
        'beer_wine_distributor', 'food_supplier', 'liquor_store',
        'restaurant', 'coffee_shop', 'hole_in_one_insurance'));
  end if;
end $$;

create index if not exists donation_prospects_tournament_status_idx
  on public.donation_prospects (tournament_id, status);
-- The follow-up cron's exact predicate: outreach sent, not yet resolved,
-- under the attempt cap.
create index if not exists donation_prospects_followup_idx
  on public.donation_prospects (last_contact_at)
  where status in ('sent', 'opened') and follow_up_count < 2;

-- ── Outreach log ────────────────────────────────────────────────────────────
-- Append-only history: every send, follow-up and reply. The prospect row
-- carries current state; this carries how it got there.
alter table public.donation_outreach_log
  add column if not exists direction        text not null default 'outbound',
  add column if not exists subject          text,
  add column if not exists body             text,
  add column if not exists message_id       text,
  add column if not exists follow_up_number integer not null default 0,
  add column if not exists error            text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'donation_outreach_log_direction_chk') then
    alter table public.donation_outreach_log add constraint donation_outreach_log_direction_chk
      check (direction in ('outbound', 'inbound'));
  end if;
end $$;

create index if not exists donation_outreach_log_prospect_idx
  on public.donation_outreach_log (prospect_id, contacted_at desc);

-- Claim-before-send idempotency, same shape as the volunteer reminders in 040:
-- the follow-up row is inserted BEFORE the email goes out, so two concurrent
-- cron runs cannot both send follow-up #1. A unique index is what makes the
-- second insert fail instead of double-emailing a vendor.
create unique index if not exists donation_outreach_followup_uniq
  on public.donation_outreach_log (prospect_id, follow_up_number)
  where direction = 'outbound';

-- ── Access ──────────────────────────────────────────────────────────────────
-- Unchanged posture from 025: service-role only, reached through owner-checked
-- API routes. Re-granting explicitly because new columns on a locked table are
-- invisible to PostgREST until the schema cache is told to reload — that is
-- what made 038 look like it had silently done nothing.
do $$
declare t text;
begin
  foreach t in array array['fb_calculations', 'donation_prospects', 'donation_outreach_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Verification: expect 16 / 17 / 6 new columns and 1 F&B plan uniqueness index.
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'fb_calculations'
       and column_name in ('player_count','volunteer_count','guest_count','holes','temperature_f',
         'precip_chance','weather_source','weather_summary','weather_fetched_at','assumptions',
         'menu','quantities','prep_timeline','headcount_locked_at','locked_player_count','handed_off_at')) as fb_columns,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'donation_prospects'
       and column_name in ('category','contact_name','status','ask_summary','draft_subject','draft_body',
         'draft_generated_at','sent_at','follow_up_count','last_contact_at','opened_at','email_opens',
         'responded_at','reply_snippet','committed_at','committed_value_cents','declined_at')) as prospect_columns,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'donation_outreach_log'
       and column_name in ('direction','subject','body','message_id','follow_up_number','error')) as log_columns;
