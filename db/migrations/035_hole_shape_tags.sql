-- Module 12 — Golf Pro Course Builder: replace the free-text hole
-- description with a canonical multi-select vocabulary of shape/feature
-- tags, so both the pro's input and the illustrative hole-map schematic
-- (SchematicSvg's fallback, never the real-GPS map) can be driven off the
-- same structured data instead of unstructured prose.
alter table public.course_holes
  add column if not exists shape_tags text[] not null default '{}';
