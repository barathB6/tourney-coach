-- Day 19 aggregation: cross-tournament independence requires knowing WHICH
-- tournament each derived feature event came from. Two tee clusters in the
-- same tournament corroborate weakly (same day, same pin sheet); clusters
-- from different tournaments are the independent sample sequences the
-- patent's confidence model counts.
--
-- Nullable: pre-existing rows (a handful of test detections) have no
-- recoverable attribution and aggregate as a single "unknown" tournament.
-- The three writers (cluster detection, green labeling, manual tee mark)
-- stamp it going forward. Idempotent.

alter table course_gps_features
  add column if not exists tournament_id uuid references tournaments(id) on delete set null;

create index if not exists course_gps_features_tournament_idx
  on course_gps_features (course_id, tournament_id);
