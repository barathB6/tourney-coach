-- Fixes a real race condition found during Day 10 concurrency stress testing:
-- the old flow read capacity/foursome-count in application code, then issued
-- a separate INSERT. Under concurrent requests, many requests read the same
-- "before" state and all proceeded — 15 concurrent single registrations
-- against an 8-player-capacity tournament all succeeded, and foursome_number
-- was assigned duplicately (ten registrations got foursome_number=1).
--
-- Fix: do the capacity check, team-join check, foursome/hole assignment, and
-- insert inside one Postgres function, opening with `SELECT ... FOR UPDATE`
-- on the tournament row. That row lock serializes concurrent registration
-- attempts for the SAME tournament (different tournaments are unaffected —
-- they lock different rows) for the duration of the transaction, so every
-- check inside sees a consistent, up-to-date picture.
CREATE OR REPLACE FUNCTION create_registration_atomic(
  p_tournament_id uuid,
  p_registration_type text,
  p_team_name text,
  p_contact_name text,
  p_contact_email text,
  p_contact_phone text,
  p_players jsonb,
  p_add_ons jsonb,
  p_total_amount_cents integer,
  p_platform_fee_cents integer,
  p_registration_source text,
  p_payment_status text
) RETURNS registrations
LANGUAGE plpgsql
AS $$
DECLARE
  v_max_players     integer;
  v_slots_used      integer;
  v_expected_players integer;
  v_team_players    integer;
  v_foursome_number integer;
  v_starting_hole   integer;
  v_new_reg         registrations;
BEGIN
  SELECT max_players INTO v_max_players
  FROM tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF v_max_players IS NULL THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE = 'P0002';
  END IF;

  v_expected_players := CASE WHEN p_registration_type = 'single' THEN 1 ELSE 4 END;

  SELECT COALESCE(SUM(CASE WHEN r.registration_type = 'single' THEN 1 ELSE 4 END), 0)
  INTO v_slots_used
  FROM registrations r
  WHERE r.tournament_id = p_tournament_id
    AND r.payment_status IN ('pending', 'paid');

  IF v_slots_used + v_expected_players > v_max_players THEN
    RAISE EXCEPTION 'Tournament is full' USING ERRCODE = 'P0001';
  END IF;

  IF p_registration_type = 'single' AND p_team_name IS NOT NULL THEN
    SELECT COALESCE(SUM(jsonb_array_length(r.players)), 0)
    INTO v_team_players
    FROM registrations r
    WHERE r.tournament_id = p_tournament_id
      AND r.team_name = p_team_name
      AND r.payment_status IN ('pending', 'paid');

    IF v_team_players + 1 > 4 THEN
      RAISE EXCEPTION 'That team is already full' USING ERRCODE = 'P0003';
    END IF;
  END IF;

  SELECT COUNT(*) + 1 INTO v_foursome_number
  FROM registrations r WHERE r.tournament_id = p_tournament_id;

  v_starting_hole := CASE WHEN p_registration_type = 'single' THEN NULL
    ELSE ((v_foursome_number - 1) % 18) + 1
  END;

  INSERT INTO registrations (
    tournament_id, registration_type, team_name, contact_name, contact_email,
    contact_phone, players, add_ons, total_amount_cents, platform_fee_cents,
    registration_source, payment_status, foursome_number, starting_hole
  ) VALUES (
    p_tournament_id, p_registration_type, p_team_name, p_contact_name, p_contact_email,
    p_contact_phone, p_players, p_add_ons, p_total_amount_cents, p_platform_fee_cents,
    p_registration_source, p_payment_status, v_foursome_number, v_starting_hole
  )
  RETURNING * INTO v_new_reg;

  RETURN v_new_reg;
END;
$$;
