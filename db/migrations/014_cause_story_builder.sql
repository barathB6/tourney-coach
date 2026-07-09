-- Cause Story Builder: structured prompts + AI-generated length variants
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_story_answers jsonb;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_story_full text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_story_medium text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_story_short text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_story_one_liner text;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS cause_story_photo_recs jsonb;
