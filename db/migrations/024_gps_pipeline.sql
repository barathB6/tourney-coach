-- GPS Mapping Data Collection Pipeline (Day 18, Module 24 / Module 8).
--
-- Table shapes follow the provisional patent filing's schema: gps_tracks
-- carries raw per-player location rows (foursome_id, player_id, decimal
-- coords), and course_gps_features holds features derived from those tracks
-- over time (tee_box/green/fairway/hazard with a confidence score). The
-- Day 17 course_holes.gps_status jsonb stays in sync as the course
-- builder's attachment point, but course_gps_features is the system of
-- record for derived features.
--
-- IMPORTANT: this migration tolerates a gps_tracks table that already
-- exists in the patent doc's bare shape (tournament_id/foursome_id/
-- player_id/lat/lng/accuracy/recorded_at only) — e.g. from the filing's
-- SQL having been run in the Supabase editor directly. The alter
-- statements below upgrade such a table in place, and every statement is
-- idempotent, so the whole file is safe to re-run after a partial failure.
--
-- Players have no login (registrations has no user_id), so a device is
-- identified by a random token generated client-side on the consent screen
-- and stored in localStorage, scoped to the registration whose link the
-- player opened. foursome_id is that registration's id — the registration
-- row IS the foursome unit in this schema. player_id links to
-- player_profiles when the player can be matched; it is nullable because
-- consent must not depend on profile matching.
--
-- All writes go through service-role API routes (there is no player auth
-- session to key RLS off), so these tables enable RLS with no public
-- policies — only the service role can read/write them. Consent is an
-- explicit opt-in event log, never a silent default.

create table if not exists gps_devices (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  device_token text not null unique,
  player_name text,
  created_at timestamptz not null default now()
);

create index if not exists gps_devices_registration_id_idx on gps_devices (registration_id);

alter table gps_devices enable row level security;

-- Append-only consent event log (granted/revoked), not a mutable boolean,
-- so there is always a provable audit trail of when a player opted in or
-- out — "Explicit opt-in only. No silent collection ever."
create table if not exists gps_consent_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references gps_devices(id) on delete cascade,
  event text not null check (event in ('granted', 'revoked')),
  created_at timestamptz not null default now()
);

create index if not exists gps_consent_events_device_id_idx on gps_consent_events (device_id);

alter table gps_consent_events enable row level security;

-- GPS TRACKS (raw location data collected during tournament play).
-- feature_type/feature_source are the score-submission/cluster tagging
-- columns: null until a mechanism labels the row.
create table if not exists gps_tracks (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id),
  foursome_id uuid not null,
  player_id uuid references player_profiles(id),
  lat decimal(10,8) not null,
  lng decimal(11,8) not null,
  accuracy decimal(6,2),
  recorded_at timestamptz default now()
);

-- Pipeline columns beyond the filing's bare schema. If gps_tracks already
-- existed (bare spec shape), these upgrade it in place; if the create above
-- just ran, they no-op.
alter table gps_tracks add column if not exists device_id uuid references gps_devices(id) on delete cascade;
alter table gps_tracks add column if not exists course_id uuid references courses(id) on delete cascade;
alter table gps_tracks add column if not exists hole_number integer check (hole_number between 1 and 18);
alter table gps_tracks add column if not exists feature_type text check (feature_type in ('tee_box', 'green', 'fairway', 'hazard'));
alter table gps_tracks add column if not exists feature_source text check (feature_source in ('cluster_detection', 'score_submission'));
alter table gps_tracks add column if not exists received_at timestamptz not null default now();

-- The filing's bare schema leaves foursome_id without a foreign key; add
-- the registrations link (and its cascade) if it is missing.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gps_tracks_foursome_id_fkey' and conrelid = 'gps_tracks'::regclass
  ) then
    alter table gps_tracks
      add constraint gps_tracks_foursome_id_fkey
      foreign key (foursome_id) references registrations(id) on delete cascade;
  end if;
end $$;

create index if not exists gps_tracks_hole_lookup_idx on gps_tracks (course_id, hole_number, feature_type);
create index if not exists gps_tracks_foursome_id_idx on gps_tracks (foursome_id);
create index if not exists gps_tracks_device_id_idx on gps_tracks (device_id);
create index if not exists gps_tracks_tournament_id_idx on gps_tracks (tournament_id);

alter table gps_tracks enable row level security;

-- COURSE MAPPING DATA (derived from GPS tracks over time).
create table if not exists course_gps_features (
  id uuid primary key default gen_random_uuid(),
  course_id uuid references courses(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  feature_type text not null check (feature_type in ('tee_box', 'green', 'fairway', 'hazard')),
  lat decimal(10,8) not null,
  lng decimal(11,8) not null,
  confidence decimal(4,2), -- 0.0-1.0, based on sample count
  sample_count integer default 1,
  derived_at timestamptz not null default now()
);

create index if not exists course_gps_features_lookup_idx on course_gps_features (course_id, hole_number, feature_type);

alter table course_gps_features enable row level security;

-- Whether a device currently has active (non-revoked) consent, derived from
-- the most recent event rather than a separate column so the event log
-- stays the single source of truth. Both the ingestion route and the
-- live-round page check this before accepting/collecting any pings.
-- security_invoker so the view respects gps_consent_events' RLS instead of
-- running with the owner's RLS-bypassing rights (the Postgres default,
-- which would let the public anon key read consent rows through the view).
-- The API routes use the service role, which bypasses RLS either way.
create or replace view gps_active_consent
with (security_invoker = true) as
select distinct on (device_id) device_id, event, created_at as changed_at
from gps_consent_events
order by device_id, created_at desc;
