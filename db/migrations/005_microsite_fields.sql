-- Add slug and microsite content fields to tournaments

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS slug             text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS microsite_color  text    DEFAULT '#1B6B3A';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS social_links     jsonb   DEFAULT '{}';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS sponsor_logos    jsonb   DEFAULT '[]';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_photos     jsonb   DEFAULT '[]';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS contact_email    text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS location_name    text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS volunteer_info   text;

-- Backfill slugs for existing tournaments
UPDATE tournaments
SET slug = lower(
  regexp_replace(
    regexp_replace(trim(name), '[^a-zA-Z0-9\s-]', '', 'g'),
    '\s+', '-', 'g'
  )
)
WHERE slug IS NULL OR slug = '';

-- Ensure slugs are unique (append -2, -3, etc. if collisions exist)
DO $$
DECLARE
  r RECORD;
  base_slug text;
  candidate text;
  counter int;
BEGIN
  FOR r IN SELECT id, slug FROM tournaments ORDER BY created_at LOOP
    base_slug := r.slug;
    candidate := base_slug;
    counter   := 2;
    WHILE EXISTS (
      SELECT 1 FROM tournaments WHERE slug = candidate AND id <> r.id
    ) LOOP
      candidate := base_slug || '-' || counter;
      counter   := counter + 1;
    END LOOP;
    IF candidate <> r.slug THEN
      UPDATE tournaments SET slug = candidate WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- Unique index on slug
CREATE UNIQUE INDEX IF NOT EXISTS tournaments_slug_idx ON tournaments (slug);

-- Public read policy: anyone can read published/live tournaments by slug
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tournaments' AND policyname = 'public can read published tournaments'
  ) THEN
    CREATE POLICY "public can read published tournaments"
      ON tournaments FOR SELECT
      USING (status IN ('published', 'live', 'completed'));
  END IF;
END $$;
