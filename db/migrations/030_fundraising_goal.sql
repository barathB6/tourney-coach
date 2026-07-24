-- Coach actions: a fundraising goal the organizer (or the AI coach on their
-- behalf) can set, shown on the dashboard's "Raised so far / of goal" card.
-- bigint (like historical_raised_cents) so large goals in cents can't overflow
-- int4. Idempotent whether the column is absent or was already added as int.
alter table tournaments add column if not exists fundraising_goal_cents bigint;
alter table tournaments alter column fundraising_goal_cents type bigint;
