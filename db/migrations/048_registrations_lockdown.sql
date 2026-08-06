-- Day 32 — registrations were world-readable.
--
-- The Day 32 security audit connected with the ANON key — the one shipped in
-- every visitor's browser bundle — and read all 56 registration rows across all
-- 11 tournaments: 40 distinct email addresses, contact names, phone numbers,
-- the players[] name arrays, player_profile_id, and adyen_psp_reference. Draft
-- tournaments included. Writes were correctly refused; reads were wide open.
--
-- 003 only ever created a SELECT policy scoped to the organizer
-- (tournament_id in (select id from tournaments where organizer_id = auth.uid())),
-- which returns nothing for anon. So the exposure came from a grant or a
-- permissive policy added to this table OUTSIDE the migrations flow — the same
-- class of problem 025 was written to sweep up, and `registrations` was on 025's
-- whitelist, so the sweep skipped it. That whitelist entry existed because the
-- browser was believed to need anon INSERT for public signups. It does not:
-- every server path that touches this table (app/api/registrations,
-- payments/*, board, leaderboard, scorecard, coach) uses the SERVICE ROLE, and
-- inserts go through the create_registration_atomic RPC.
--
-- So this revokes anon outright and rebuilds the policies from scratch rather
-- than patching around whatever is currently there. Catalog-driven, because the
-- offending policy's name is not known here.

-- 1. Drop every existing policy on the table, whatever it is called.
do $$
declare p record;
begin
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'registrations'
  loop
    execute format('drop policy if exists %I on public.registrations', p.policyname);
    raise notice 'dropped registrations policy: %', p.policyname;
  end loop;
end $$;

alter table public.registrations enable row level security;

-- 2. The browser reaches this table only as a signed-in organizer, and only for
--    tournaments they own. Anon has no business here at all: the public
--    registration page's "spots remaining" comes from
--    /api/tournaments/[id]/progress, which is service-role and returns a bare
--    count with no PII.
revoke all on table public.registrations from anon;
grant select, update on table public.registrations to authenticated;

create policy "organizer reads own tournament registrations"
  on public.registrations for select to authenticated
  using (tournament_id in (select id from tournaments where organizer_id = auth.uid()));

create policy "organizer updates own tournament registrations"
  on public.registrations for update to authenticated
  using (tournament_id in (select id from tournaments where organizer_id = auth.uid()))
  with check (tournament_id in (select id from tournaments where organizer_id = auth.uid()));

-- Deliberately NO insert policy and NO anon grant. Public signups are created
-- server-side by the service role, which bypasses RLS, so the previous
-- "anyone can insert registration" WITH CHECK (true) bought nothing and let
-- anyone write arbitrary rows straight into the table.
