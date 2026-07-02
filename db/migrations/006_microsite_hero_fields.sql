-- Additional fields for microsite hero section
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_tagline          text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS edition_label          text;   -- e.g. "5TH ANNUAL"
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS shotgun_time           text;   -- e.g. "8:30 AM"
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS historical_raised_cents bigint DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_org              text;   -- e.g. "St. Michael's Catholic School"
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS sponsor_hole_url       text;
