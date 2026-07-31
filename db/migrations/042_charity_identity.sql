-- Day 28 (Module 09) — charity identity for donation acknowledgement letters.
--
-- An in-kind acknowledgement letter is only usable if it carries the 501(c)(3)'s
-- LEGAL name, its EIN, and a mailing address. None of those are the tournament's
-- name or the organizer's address, and none of them existed on `tournaments`:
-- `cause_org` is marketing copy ("Monterey Youth Golf"), not the registered
-- entity ("Monterey Youth Golf Foundation, Inc.").
--
-- Stored on the tournament rather than the profile because one organizer can
-- run events for more than one charity.

alter table public.tournaments
  add column if not exists charity_legal_name text,
  add column if not exists charity_ein        text,
  add column if not exists charity_address    text,
  -- Signage, podium mention, social thanks. Required in the letter: a charity
  -- must state what, if anything, it gave in return for the contribution.
  add column if not exists donor_benefits     text;

-- EIN is stored as text on purpose — it is an identifier with a hyphen
-- (12-3456789), not a number. A light format check catches typos without
-- rejecting a legitimate value we haven't anticipated.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tournaments_charity_ein_chk') then
    alter table public.tournaments add constraint tournaments_charity_ein_chk
      check (charity_ein is null or charity_ein ~ '^[0-9]{2}-?[0-9]{7}$');
  end if;
end $$;

notify pgrst, 'reload schema';

-- Verification: expect 4.
select count(*) as charity_columns
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tournaments'
   and column_name in ('charity_legal_name', 'charity_ein', 'charity_address', 'donor_benefits');
