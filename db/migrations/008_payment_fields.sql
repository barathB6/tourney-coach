-- Add Adyen payment reference to registrations
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS adyen_psp_reference text;

CREATE INDEX IF NOT EXISTS registrations_psp_reference_idx
  ON registrations (adyen_psp_reference)
  WHERE adyen_psp_reference IS NOT NULL;
