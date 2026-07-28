-- Hotfix (2026-07-28): tournament creation fails with
-- "permission denied for table guidance_profiles".
--
-- Cause: the spec-paste that created the locked-down tables (see 025) ALSO
-- created trigger(s) — e.g. on tournaments — whose functions write to those
-- tables (guidance_profiles, task_templates, ...). Triggers run with the
-- invoking role's privileges, so after 025 revoked anon/authenticated from
-- every spec table, any insert/update that fires such a trigger now aborts
-- for signed-in users. That broke the setup wizard's Publish (POST
-- /api/tournaments runs as `authenticated`).
--
-- Fix, catalog-driven like 025: drop every non-internal trigger on a public
-- table whose function body references a locked spec table. App-owned
-- triggers survive — trg_tournaments_updated_at touches only its own row,
-- and 004's player-profile trigger references whitelisted tables only.
-- \m / \M are word boundaries, so e.g. "holes" does NOT match course_holes
-- and "scores" does NOT match score_submissions.
--
-- Idempotent: re-running finds nothing to drop.

do $$
declare
  trg record;
begin
  for trg in
    select tg.tgname, c.relname
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where n.nspname = 'public'
      and not tg.tgisinternal
      and pg_get_functiondef(p.oid) ~*
        '\m(guidance_profiles|task_templates|role_templates|fb_calculations|communication_log|donation_prospects|donation_outreach_log|tournament_volunteer_assignments|player_notification_preferences|player_notification_log|scores|holes|volunteers)\M'
  loop
    execute format('drop trigger %I on public.%I', trg.tgname, trg.relname);
    raise notice 'dropped spec trigger % on %', trg.tgname, trg.relname;
  end loop;
end $$;
