-- No DELETE policy existed for tournaments — organizers had no way to
-- remove a tournament they own (RLS defaults to deny). registrations and
-- volunteer_signups already cascade-delete via their FK constraints
-- (migrations 003, 007), so deleting the tournament row is sufficient.
CREATE POLICY "organizer can delete own tournaments"
  ON tournaments FOR DELETE
  USING (organizer_id = auth.uid());
