-- Platform fee: 2.5% on entry fees, recorded per registration at insert time
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS platform_fee_cents integer;
