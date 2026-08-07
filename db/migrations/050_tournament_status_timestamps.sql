-- Day 33 — the status-transition timestamps the code has always referenced.
--
-- lib/tournaments.ts getTimestampField() returns 'published_at' / 'live_at' /
-- 'completed_at' for the three forward transitions, and the PUT handler writes
-- whichever applies. But these columns were never added to the table, so the
-- FIRST TIME anything actually transitioned a tournament — which turned out to
-- be never, until the Day 33 dry run added a publish control — the update
-- 500'd and publishing failed outright.
--
-- The handler now tolerates their absence (it drops the timestamp and retries),
-- so publishing works with or without this migration. Applying it just lets the
-- platform record WHEN each tournament went public, live and final — useful for
-- the beta post-mortem and for any "published N days before the event" metric.
alter table public.tournaments
  add column if not exists published_at timestamptz,
  add column if not exists live_at      timestamptz,
  add column if not exists completed_at timestamptz;

-- Backfill: every already-published tournament went public at some point in the
-- past; created_at is the best lower-bound estimate we have and is better than
-- NULL for anything that reads "time since publish". Only touches rows that are
-- past draft and have no timestamp yet, so it is safe to re-run.
update public.tournaments
   set published_at = coalesce(published_at, created_at)
 where status in ('published', 'live', 'completed');
update public.tournaments
   set live_at = coalesce(live_at, created_at)
 where status in ('live', 'completed');
update public.tournaments
   set completed_at = coalesce(completed_at, created_at)
 where status = 'completed';
