-- Day 30 (follow-up) — in-site volunteer sign-in.
--
-- Volunteers could only reach their view by clicking a link we emailed or
-- texted them. That is a poor experience — you are already on the site, and
-- now you have to go and find an email.
--
-- The obvious fix is dangerous: simply showing somebody's portal because they
-- typed an email address would hand out a credential. The invite token exposes
-- that volunteer's name, role, tasks and message thread, and lets the holder
-- decline their role or write to the organizer as them. Anyone who knew a
-- volunteer's email could do all of that, and could enumerate who volunteers.
--
-- So: a short-lived one-time code, sent to the contact they claim, entered on
-- the same page. They never leave the site, and possession of the email or
-- phone is still what proves identity.
--
-- The code is stored HASHED with a server-side pepper: a leak of this table
-- must not hand anyone a working code. Three defences beyond that — a ten
-- minute expiry, an attempt cap, and single use — because a six digit code is
-- only 10^6 and none of those defences is sufficient alone.

create table if not exists public.volunteer_access_codes (
  id           uuid primary key default gen_random_uuid(),
  -- The normalised contact (lowercased email or E.164 phone). Hashed too: this
  -- table should not be a list of who volunteers.
  contact_hash text not null,
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists volunteer_access_codes_lookup
  on public.volunteer_access_codes (contact_hash, created_at desc);
-- Sweep target: nothing here is worth keeping once it has expired.
create index if not exists volunteer_access_codes_expiry
  on public.volunteer_access_codes (expires_at);

-- ── Access ──────────────────────────────────────────────────────────────────
-- Service role only. The browser never reads this table; it only ever posts a
-- code to an API route that checks it.
alter table public.volunteer_access_codes enable row level security;
revoke all on public.volunteer_access_codes from anon, authenticated;
grant all on public.volunteer_access_codes to service_role;

notify pgrst, 'reload schema';

-- Verification: expect 1.
select count(*) as new_table
  from information_schema.tables
 where table_schema = 'public' and table_name = 'volunteer_access_codes';
