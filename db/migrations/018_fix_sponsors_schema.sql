-- migration 017 used `create table if not exists sponsors`, but a `sponsors`
-- table already existed from an earlier, unused feature with a different
-- shape (name, tier text, donation_amount_cents, website_url — no contact
-- info, no status pipeline). `if not exists` silently kept the old schema.
-- This migration brings the real table up to what the sponsorship module
-- needs, preserving any existing rows.

do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'name')
     and not exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'company') then
    alter table sponsors rename column name to company;
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'donation_amount_cents')
     and not exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'amount_cents') then
    alter table sponsors rename column donation_amount_cents to amount_cents;
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'website_url')
     and not exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'website') then
    alter table sponsors rename column website_url to website;
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'sponsors' and column_name = 'tier'
             and data_type = 'text') then
    alter table sponsors drop column tier;
  end if;
end $$;

alter table sponsors alter column company set not null;
alter table sponsors alter column amount_cents drop not null;
alter table sponsors alter column amount_cents drop default;

alter table sponsors add column if not exists tier_id uuid references sponsorship_tiers(id) on delete set null;
alter table sponsors add column if not exists contact_name text;
alter table sponsors add column if not exists contact_title text;
alter table sponsors add column if not exists email text;
alter table sponsors add column if not exists phone text;
alter table sponsors add column if not exists notes text;
alter table sponsors add column if not exists status text not null default 'not_contacted';
alter table sponsors add column if not exists source text not null default 'organizer';
alter table sponsors add column if not exists adyen_psp_reference text;
alter table sponsors add column if not exists logo_received boolean not null default false;
alter table sponsors add column if not exists signage_created boolean not null default false;
alter table sponsors add column if not exists placement_confirmed boolean not null default false;
alter table sponsors add column if not exists last_touch timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sponsors_status_check') then
    alter table sponsors add constraint sponsors_status_check
      check (status in ('not_contacted', 'contacted', 'no_reply', 'verbal', 'invoiced', 'pending', 'paid', 'declined'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sponsors_source_check') then
    alter table sponsors add constraint sponsors_source_check
      check (source in ('organizer', 'self_purchase'));
  end if;
end $$;

create index if not exists idx_sponsors_tournament on sponsors(tournament_id, created_at desc);

alter table sponsors enable row level security;

drop policy if exists "Organizer can manage own sponsors" on sponsors;
create policy "Organizer can manage own sponsors"
  on sponsors for all
  to authenticated
  using (tournament_id in (select id from tournaments where organizer_id = auth.uid()))
  with check (tournament_id in (select id from tournaments where organizer_id = auth.uid()));
