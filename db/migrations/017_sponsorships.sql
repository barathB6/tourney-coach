-- Sponsorship module: package tiers + sponsor prospects/purchases.

create table if not exists sponsorship_tiers (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  name text not null,
  label text,                      -- short badge label e.g. "Title", "Eagle"
  price_cents integer not null default 0 check (price_cents >= 0),
  benefits jsonb not null default '[]'::jsonb,   -- array of benefit strings
  quantity smallint,               -- max available; null = unlimited
  highlight boolean not null default false,      -- gold/title treatment
  sort_order smallint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists sponsors (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  tier_id uuid references sponsorship_tiers(id) on delete set null,
  company text not null,
  contact_name text,
  contact_title text,
  email text,
  phone text,
  website text,
  logo_url text,
  notes text,
  -- prospect pipeline → purchase
  status text not null default 'not_contacted' check (status in (
    'not_contacted', 'contacted', 'no_reply', 'verbal', 'invoiced', 'pending', 'paid', 'declined'
  )),
  amount_cents integer,            -- agreed/charged amount (defaults to tier price)
  source text not null default 'organizer' check (source in ('organizer', 'self_purchase')),
  adyen_psp_reference text,
  -- fulfillment tracking
  logo_received boolean not null default false,
  signage_created boolean not null default false,
  placement_confirmed boolean not null default false,
  last_touch timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_sponsorship_tiers_tournament
  on sponsorship_tiers(tournament_id, sort_order);
create index if not exists idx_sponsors_tournament
  on sponsors(tournament_id, created_at desc);

alter table sponsorship_tiers enable row level security;
alter table sponsors enable row level security;

-- Organizers manage their own tiers
drop policy if exists "Organizer can manage own tiers" on sponsorship_tiers;
create policy "Organizer can manage own tiers"
  on sponsorship_tiers for all
  to authenticated
  using (tournament_id in (select id from tournaments where organizer_id = auth.uid()))
  with check (tournament_id in (select id from tournaments where organizer_id = auth.uid()));

-- Public can view tiers of published tournaments (microsite sales page)
drop policy if exists "Public can view tiers of published tournaments" on sponsorship_tiers;
create policy "Public can view tiers of published tournaments"
  on sponsorship_tiers for select
  to anon, authenticated
  using (tournament_id in (select id from tournaments where status in ('published', 'live', 'completed')));

-- Organizers manage their own sponsors
drop policy if exists "Organizer can manage own sponsors" on sponsors;
create policy "Organizer can manage own sponsors"
  on sponsors for all
  to authenticated
  using (tournament_id in (select id from tournaments where organizer_id = auth.uid()))
  with check (tournament_id in (select id from tournaments where organizer_id = auth.uid()));
