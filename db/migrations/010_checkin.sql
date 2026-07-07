ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
