-- Create profiles table linked to auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  phone text,
  role text default 'user',
  created_at timestamptz default now()
);

-- Enable row level security
alter table public.profiles enable row level security;

-- Allow users to select/insert/update/delete only their own profile
create policy "Profiles: self access" on public.profiles
  for all
  using ( auth.uid() = id )
  with check ( auth.uid() = id );
