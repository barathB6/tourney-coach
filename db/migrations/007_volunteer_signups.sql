CREATE TABLE IF NOT EXISTS volunteer_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  role text,
  created_at timestamptz DEFAULT now()
);

-- Allow anyone to insert (public volunteer form)
ALTER TABLE volunteer_signups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can insert volunteer signups"
  ON volunteer_signups FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Only the tournament organizer can read signups
CREATE POLICY "Organizer can read their volunteer signups"
  ON volunteer_signups FOR SELECT
  TO authenticated
  USING (
    tournament_id IN (
      SELECT id FROM tournaments WHERE organizer_id = auth.uid()
    )
  );
