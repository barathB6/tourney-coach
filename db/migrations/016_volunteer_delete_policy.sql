-- Allow tournament organizers to remove volunteer sign-ups for their events.

drop policy if exists "Organizer can delete their volunteer signups" on volunteer_signups;
create policy "Organizer can delete their volunteer signups"
  on volunteer_signups for delete
  to authenticated
  using (
    tournament_id in (
      select id from tournaments where organizer_id = auth.uid()
    )
  );
