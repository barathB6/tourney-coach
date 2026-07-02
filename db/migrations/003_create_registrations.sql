-- Registrations table
-- payment_status starts as 'pending'; updated to 'paid' by webhook when processor is integrated
-- foursome_number and starting_hole assigned at insert time by API route

CREATE TABLE IF NOT EXISTS registrations (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tournament_id        uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  registration_type    text NOT NULL CHECK (registration_type IN ('foursome', 'single', 'sponsor')),
  team_name            text,
  contact_name         text NOT NULL,
  contact_email        text NOT NULL,
  contact_phone        text,
  players              jsonb NOT NULL DEFAULT '[]',  -- [{name: string, email: string}]
  add_ons              jsonb NOT NULL DEFAULT '[]',  -- ['mulligans', 'putting']
  total_amount_cents   integer NOT NULL,
  registration_source  text CHECK (registration_source IN (
                         'tourneycircle', 'direct', 'google', 'social',
                         'word_of_mouth', 'golf_pro_referral', 'other'
                       )),
  payment_status       text NOT NULL DEFAULT 'pending'
                         CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  foursome_number      integer,
  starting_hole        integer,
  confirmation_sent_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Row-level security: organizers can read their own tournament's registrations
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "organizer can read own tournament registrations"
  ON registrations FOR SELECT
  USING (
    tournament_id IN (
      SELECT id FROM tournaments WHERE organizer_id = auth.uid()
    )
  );

-- Public insert (players register without being logged in)
CREATE POLICY "anyone can insert registration"
  ON registrations FOR INSERT
  WITH CHECK (true);

-- Index for dashboard count query
CREATE INDEX IF NOT EXISTS registrations_tournament_id_idx
  ON registrations (tournament_id);
