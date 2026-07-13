-- Storage bucket for sponsor logo uploads. Public read (logos display on
-- the public microsite), write restricted to the organizer who owns the
-- tournament the logo's folder is scoped to.
--
-- Objects are stored at: <tournament_id>/<sponsor_id>-<filename>
-- so RLS can check ownership from the path alone without a join per file.

insert into storage.buckets (id, name, public)
values ('sponsor-logos', 'sponsor-logos', true)
on conflict (id) do nothing;

drop policy if exists "Public can view sponsor logos" on storage.objects;
create policy "Public can view sponsor logos"
  on storage.objects for select
  to public
  using (bucket_id = 'sponsor-logos');

drop policy if exists "Organizers can upload their sponsor logos" on storage.objects;
create policy "Organizers can upload their sponsor logos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'sponsor-logos'
    and (storage.foldername(name))[1]::uuid in (
      select id from tournaments where organizer_id = auth.uid()
    )
  );

drop policy if exists "Organizers can update their sponsor logos" on storage.objects;
create policy "Organizers can update their sponsor logos"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'sponsor-logos'
    and (storage.foldername(name))[1]::uuid in (
      select id from tournaments where organizer_id = auth.uid()
    )
  );

drop policy if exists "Organizers can delete their sponsor logos" on storage.objects;
create policy "Organizers can delete their sponsor logos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'sponsor-logos'
    and (storage.foldername(name))[1]::uuid in (
      select id from tournaments where organizer_id = auth.uid()
    )
  );
