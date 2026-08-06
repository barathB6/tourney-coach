-- Day 31 — the volunteer access-code limits, enforced by the database.
--
-- Both limits were read-then-write in app code, and the Day 31 concurrency
-- suite walked straight through them:
--
--   issue   ten simultaneous "send me a code" requests each counted the same
--           zero rows and each inserted — 10 live codes against a cap of 5.
--           Beyond widening the guessing window, that is an unbounded
--           SendGrid/Twilio spend anyone can trigger by knowing an email.
--
--   verify  five simultaneous wrong guesses each read attempts = 0 and each
--           wrote 1, so the five-attempt cap cost an attacker one attempt.
--           Parallelised, the code never dies.
--
-- Both are now single statements inside one transaction, serialised per
-- contact: issuing takes a transaction-scoped advisory lock on the contact
-- hash, verifying takes a row lock. Concurrency queues instead of racing.
--
-- The code comparison is a plain `=` on a SHA-256 digest of a peppered value.
-- Non-constant-time equality is not a leak here: an attacker cannot steer the
-- stored digest without the pepper, so there is no gradient to walk.

create or replace function public.issue_volunteer_code(
  p_contact_hash text,
  p_code_hash    text,
  p_expires_at   timestamptz,
  p_max_per_hour int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent int;
begin
  -- Serialise every issue for this contact. Transaction-scoped, so it releases
  -- on commit or rollback without any unlock bookkeeping.
  perform pg_advisory_xact_lock(hashtextextended(p_contact_hash, 0));

  select count(*) into v_recent
    from volunteer_access_codes
   where contact_hash = p_contact_hash
     and created_at >= now() - interval '1 hour';

  if v_recent >= p_max_per_hour then
    return false;
  end if;

  insert into volunteer_access_codes (contact_hash, code_hash, expires_at)
  values (p_contact_hash, p_code_hash, p_expires_at);

  return true;
end;
$$;

-- Returns one of: 'ok', 'expired', 'wrong', 'exhausted', 'none'.
create or replace function public.verify_volunteer_code(
  p_contact_hash text,
  p_code_hash    text,
  p_max_attempts int
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row volunteer_access_codes%rowtype;
begin
  -- FOR UPDATE is the whole fix: concurrent guesses queue on this row instead
  -- of each reading the same stale attempts count.
  select * into v_row
    from volunteer_access_codes
   where contact_hash = p_contact_hash
     and consumed_at is null
   order by created_at desc
   limit 1
     for update;

  if not found then return 'none'; end if;
  if v_row.expires_at < now() then return 'expired'; end if;
  if v_row.attempts >= p_max_attempts then return 'exhausted'; end if;

  if v_row.code_hash <> p_code_hash then
    update volunteer_access_codes
       set attempts = attempts + 1
     where id = v_row.id;
    return case when v_row.attempts + 1 >= p_max_attempts then 'exhausted' else 'wrong' end;
  end if;

  update volunteer_access_codes set consumed_at = now() where id = v_row.id;
  return 'ok';
end;
$$;

revoke all on function public.issue_volunteer_code(text, text, timestamptz, int) from anon, authenticated;
revoke all on function public.verify_volunteer_code(text, text, int) from anon, authenticated;
