-- Migrate existing registrations table to match the API schema
-- Safe to run: only one test row exists, all nullable fields are null

-- 1. Rename columns that map directly
ALTER TABLE registrations RENAME COLUMN player_name          TO contact_name;
ALTER TABLE registrations RENAME COLUMN player_email         TO contact_email;
ALTER TABLE registrations RENAME COLUMN payment_amount_cents TO total_amount_cents;

-- 2. Replace foursome_id (unknown type) and hole_assignment with typed integer columns
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS foursome_number integer;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS starting_hole   integer;
-- Copy any existing values (best-effort; foursome_id may be uuid so cast is skipped)
-- ALTER TABLE registrations UPDATE SET foursome_number = foursome_id::integer; -- uncomment if foursome_id was integer
ALTER TABLE registrations DROP COLUMN IF EXISTS foursome_id;
ALTER TABLE registrations DROP COLUMN IF EXISTS hole_assignment;

-- 3. Add missing columns
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS registration_type   text NOT NULL DEFAULT 'foursome';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS contact_phone        text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS players              jsonb NOT NULL DEFAULT '[]';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS add_ons              jsonb NOT NULL DEFAULT '[]';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;

-- 4. Add check constraint on registration_type
ALTER TABLE registrations
  ADD CONSTRAINT registrations_type_check
  CHECK (registration_type IN ('foursome', 'single', 'sponsor'));

-- 5. Ensure RLS is on and policies exist
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'registrations' AND policyname = 'organizer can read own tournament registrations'
  ) THEN
    CREATE POLICY "organizer can read own tournament registrations"
      ON registrations FOR SELECT
      USING (
        tournament_id IN (
          SELECT id FROM tournaments WHERE organizer_id = auth.uid()
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'registrations' AND policyname = 'anyone can insert registration'
  ) THEN
    CREATE POLICY "anyone can insert registration"
      ON registrations FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

-- 6. Index for dashboard count query
CREATE INDEX IF NOT EXISTS registrations_tournament_id_idx
  ON registrations (tournament_id);
