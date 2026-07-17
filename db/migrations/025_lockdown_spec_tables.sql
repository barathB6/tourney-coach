-- Security lockdown (2026-07-17).
--
-- 1) A dozen-plus tables were created by pasting SQL from the product spec /
--    provisional patent doc directly into the Supabase SQL editor, outside
--    this migrations flow (scores, holes, volunteers, communication_log,
--    donation_prospects, donation_outreach_log, fb_calculations,
--    guidance_profiles, task_templates, role_templates,
--    player_notification_*, tournament_volunteer_assignments, ...). None had
--    RLS, so the PUBLIC ANON KEY (shipped in every visitor's browser bundle)
--    could read — and likely write — all of them via PostgREST. All were
--    empty when this was found, so nothing leaked. No app code references
--    them yet; several (scores, holes) are intended for future features, so
--    they are locked down, NOT dropped.
--
--    Rather than trusting a hand-maintained name list, the block below is
--    catalog-driven: it locks EVERY public table except the known app
--    tables listed in the whitelist. Locking means enable RLS (no policies
--    — service-role only, same pattern as the GPS tables in 024) plus
--    revoking the anon/authenticated grants so probes fail loudly with
--    "permission denied" instead of returning empty 200s. Service-role
--    access is unaffected.
--
--    NOTE: we do NOT gate the loop on "RLS currently disabled". Several of
--    the spec-pasted tables were created with RLS already enabled but no
--    policies AND the anon grant left intact — so they returned empty 200s,
--    not errors. RLS-without-revoke still lets PostgREST answer; it's the
--    grant revoke that produces the hard 401. Processing every
--    non-whitelisted table unconditionally (enable RLS is a no-op when
--    already on) catches those too.
--
-- 2) The GPS tables from 024 get the same grant revoke explicitly (they
--    already have RLS enabled, so the catalog loop skips them).
--
-- 3) gps_active_consent view: Postgres views default to definer semantics,
--    which BYPASSES RLS on the tables underneath — the anon key could read
--    consent rows through the view. security_invoker fixes that; the grant
--    revoke closes the front door too. (Also patched in 024 for fresh
--    installs; this covers databases where 024 ran before the fix.)
--
-- 4) profiles: the "self access" FOR ALL policy from 001 let any signed-in
--    user UPDATE their own row — including `role`, which /api/gps/admin/stats
--    trusts for admin gating. Nothing in the app writes profiles from the
--    client (verified — reads only), so client INSERT/UPDATE/DELETE is
--    revoked outright. If a client-side profile editor is ever built, grant
--    back column-scoped update: grant update (name, phone) on profiles ...
--
-- Everything here is idempotent and safe to re-run.

do $$
declare
  t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename not in (
        -- Known app tables that the browser (anon key) legitimately reads
        -- or writes — each managed by db/migrations with its own RLS
        -- policies and grants. They MUST stay out of this loop or the app
        -- breaks (e.g. anon INSERT on registrations for public signups).
        -- This list matches every non-GPS table referenced by a client
        -- component; GPS tables are absent on purpose (service-role only).
        'profiles',
        'tournaments',
        'registrations',
        'player_profiles',
        'volunteer_signups',
        'coach_conversations',
        'coach_messages',
        'sponsors',
        'sponsorship_tiers',
        'courses',
        'course_holes'
      )
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('revoke all on table public.%I from anon, authenticated', t.tablename);
    raise notice 'locked down: %', t.tablename;
  end loop;
end $$;

-- GPS pipeline tables: RLS already on (024); revoke the grants as well so
-- anon/authenticated probes get "permission denied" rather than empty sets.
revoke all on table gps_devices, gps_consent_events, gps_tracks, course_gps_features from anon, authenticated;

-- Consent view: respect underlying RLS and drop anon/authenticated access.
alter view if exists gps_active_consent set (security_invoker = true);
revoke all on gps_active_consent from anon, authenticated;

-- profiles: reads stay (RLS limits them to the user's own row); client
-- writes are revoked — closes the role self-promotion hole.
revoke insert, update, delete on public.profiles from anon, authenticated;
