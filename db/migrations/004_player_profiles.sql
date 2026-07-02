-- Cross-tournament identity matching
-- Creates player_profiles and a trigger that runs on every registration insert.
-- Matching hierarchy:
--   1. Exact email match  → definitive (same person)
--   2. Normalized name + phone → strong match
-- New profile created when no match found.

-- 1. player_profiles table
CREATE TABLE IF NOT EXISTS player_profiles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text,
  name                 text NOT NULL,
  phone                text,
  first_registration_id uuid,                       -- back-filled after insert
  tournament_ids       uuid[]    NOT NULL DEFAULT '{}',
  registration_count   integer   NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Unique index on lower(email) so NULL emails don't collide
CREATE UNIQUE INDEX IF NOT EXISTS player_profiles_email_idx
  ON player_profiles (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS player_profiles_name_phone_idx
  ON player_profiles (lower(name), phone);

-- 2. Link column on registrations
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS player_profile_id uuid REFERENCES player_profiles(id);

-- 3. RLS on player_profiles
ALTER TABLE player_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'player_profiles'
      AND policyname = 'organizer can read profiles for their tournaments'
  ) THEN
    CREATE POLICY "organizer can read profiles for their tournaments"
      ON player_profiles FOR SELECT
      USING (
        id IN (
          SELECT player_profile_id
          FROM registrations r
          JOIN tournaments t ON t.id = r.tournament_id
          WHERE t.organizer_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 4. Matching function
CREATE OR REPLACE FUNCTION match_or_create_player_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id    uuid;
  v_email_lower   text := lower(trim(NEW.contact_email));
  v_name_lower    text := lower(trim(NEW.contact_name));
BEGIN
  -- Level 1: email match
  IF v_email_lower IS NOT NULL THEN
    SELECT id INTO v_profile_id
    FROM player_profiles
    WHERE lower(email) = v_email_lower
    LIMIT 1;
  END IF;

  -- Level 2: name + phone match
  IF v_profile_id IS NULL AND NEW.contact_phone IS NOT NULL THEN
    SELECT id INTO v_profile_id
    FROM player_profiles
    WHERE lower(name) = v_name_lower
      AND phone = NEW.contact_phone
    LIMIT 1;
  END IF;

  IF v_profile_id IS NOT NULL THEN
    -- Update existing profile
    UPDATE player_profiles SET
      email              = COALESCE(email, v_email_lower),
      phone              = COALESCE(phone, NEW.contact_phone),
      tournament_ids     = array_append(
                             array_remove(tournament_ids, NEW.tournament_id),
                             NEW.tournament_id
                           ),
      registration_count = registration_count + 1,
      updated_at         = now()
    WHERE id = v_profile_id;
  ELSE
    -- Create new profile
    INSERT INTO player_profiles (email, name, phone, first_registration_id, tournament_ids)
    VALUES (
      NULLIF(v_email_lower, ''),
      NEW.contact_name,
      NEW.contact_phone,
      NEW.id,
      ARRAY[NEW.tournament_id]
    )
    RETURNING id INTO v_profile_id;
  END IF;

  -- Link registration → profile
  UPDATE registrations
  SET player_profile_id = v_profile_id
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

-- 5. Trigger
DROP TRIGGER IF EXISTS trg_registration_identity_match ON registrations;
CREATE TRIGGER trg_registration_identity_match
  AFTER INSERT ON registrations
  FOR EACH ROW
  EXECUTE FUNCTION match_or_create_player_profile();

-- 6. Back-fill existing registrations (runs matcher logic inline for existing rows)
DO $$
DECLARE
  r registrations%ROWTYPE;
  v_profile_id uuid;
  v_email_lower text;
  v_name_lower  text;
BEGIN
  FOR r IN SELECT * FROM registrations WHERE player_profile_id IS NULL ORDER BY created_at LOOP
    v_email_lower := lower(trim(r.contact_email));
    v_name_lower  := lower(trim(r.contact_name));

    -- Level 1: email
    IF v_email_lower IS NOT NULL THEN
      SELECT id INTO v_profile_id FROM player_profiles
      WHERE lower(email) = v_email_lower LIMIT 1;
    END IF;

    -- Level 2: name + phone
    IF v_profile_id IS NULL AND r.contact_phone IS NOT NULL THEN
      SELECT id INTO v_profile_id FROM player_profiles
      WHERE lower(name) = v_name_lower AND phone = r.contact_phone LIMIT 1;
    END IF;

    IF v_profile_id IS NOT NULL THEN
      UPDATE player_profiles SET
        email              = COALESCE(email, v_email_lower),
        phone              = COALESCE(phone, r.contact_phone),
        tournament_ids     = array_append(array_remove(tournament_ids, r.tournament_id), r.tournament_id),
        registration_count = registration_count + 1,
        updated_at         = now()
      WHERE id = v_profile_id;
    ELSE
      INSERT INTO player_profiles (email, name, phone, first_registration_id, tournament_ids)
      VALUES (NULLIF(v_email_lower, ''), r.contact_name, r.contact_phone, r.id, ARRAY[r.tournament_id])
      RETURNING id INTO v_profile_id;
    END IF;

    UPDATE registrations SET player_profile_id = v_profile_id WHERE id = r.id;
    v_profile_id := NULL;
  END LOOP;
END $$;
