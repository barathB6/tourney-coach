-- Found via testing tournament deletion: the live registrations_tournament_id_fkey
-- constraint does NOT have ON DELETE CASCADE, despite migration 003 specifying it —
-- the table was likely already created (with a plain, non-cascading FK) before that
-- migration ran, so CREATE TABLE IF NOT EXISTS was a no-op and the CASCADE clause
-- never took effect. Deleting a tournament with registrations failed with a 23503
-- foreign key violation instead of cascading.
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_tournament_id_fkey;
ALTER TABLE registrations ADD CONSTRAINT registrations_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;

ALTER TABLE volunteer_signups DROP CONSTRAINT IF EXISTS volunteer_signups_tournament_id_fkey;
ALTER TABLE volunteer_signups ADD CONSTRAINT volunteer_signups_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
