-- Shotgun Start Manager (Day 16, Module 16).
--
-- Hole-by-hole start assignments live on registrations (starting_hole already
-- exists from migration 003); start_slot adds the A/B double-stack position.
-- Course hole pars live on the tournament as an 18-element jsonb array so the
-- capacity math (par 3 = 1 team, par 4/5 = 2 teams) can be computed per course.

-- Standard par-72 layout: 4 par-3s, 10 par-4s, 4 par-5s (front 36 / back 36).
alter table tournaments add column if not exists hole_pars jsonb
  not null default '[4,3,5,4,3,4,5,4,4,4,5,3,4,4,5,3,4,4]'::jsonb;

alter table registrations add column if not exists start_slot text
  check (start_slot in ('A', 'B'));

-- Organizers need to write hole assignments onto their own tournaments'
-- registrations. No update policy existed at all (only select + insert).
drop policy if exists "organizer can update own tournament registrations" on registrations;
create policy "organizer can update own tournament registrations"
  on registrations for update
  to authenticated
  using (
    tournament_id in (select id from tournaments where organizer_id = auth.uid())
  )
  with check (
    tournament_id in (select id from tournaments where organizer_id = auth.uid())
  );
