// One-time codes for in-site volunteer sign-in.
//
// The threat this exists to stop: a volunteer's invite token is a credential.
// It exposes their name, role, checklist and message thread, and lets whoever
// holds it decline their role or write to the organizer as them. Showing that
// to anyone who types an email address would be a breach and an enumeration
// oracle in one.
//
// So possession of the email or phone still proves identity — we just stop
// making the volunteer leave the site to demonstrate it.
//
// Defences, deliberately layered because a six-digit code is only 10^6:
//   - hashed at rest, with a server-side pepper (a table leak grants nothing)
//   - ten minute expiry
//   - five attempts per code, then it is dead
//   - single use
//   - a request cap per contact per hour, so the code cannot be reissued
//     endlessly to widen the guessing window

import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
/** Codes issuable to one contact per hour. */
export const MAX_REQUESTS_PER_HOUR = 5;

// A dedicated pepper if configured; otherwise the service role key, which is
// already the most sensitive secret this process holds and never leaves it.
// Falling back keeps self-hosted installs working without a new required var.
const pepper = () => process.env.VOLUNTEER_CODE_PEPPER || process.env.SUPABASE_SERVICE_ROLE_KEY || 'tc-dev-pepper';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashContact = (contact: string) => sha(`contact:${pepper()}:${contact}`);
const hashCode = (contact: string, code: string) => sha(`code:${pepper()}:${contact}:${code}`);

/** Six digits, uniformly random. Not Math.random — this is a credential. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface IssueResult { ok: boolean; code?: string; rateLimited?: boolean }

/**
 * Issue a code for a contact. Returns the plaintext ONCE, for sending — it is
 * never stored and never returned again.
 */
export async function issueCode(service: DB, contact: string): Promise<IssueResult> {
  const ch = hashContact(contact);
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { data: recent } = await service.from('volunteer_access_codes')
    .select('id').eq('contact_hash', ch).gte('created_at', since);
  if ((recent ?? []).length >= MAX_REQUESTS_PER_HOUR) return { ok: false, rateLimited: true };

  const code = generateCode();
  const { error } = await service.from('volunteer_access_codes').insert({
    contact_hash: ch,
    code_hash: hashCode(contact, code),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (error) return { ok: false };
  return { ok: true, code };
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'wrong' | 'exhausted' | 'none' };

/**
 * Check a code. Consumes it on success; burns an attempt on failure. Compared
 * with a constant-time equality so the check itself leaks nothing.
 */
export async function verifyCode(service: DB, contact: string, code: string): Promise<VerifyOutcome> {
  const ch = hashContact(contact);
  const { data: rows } = await service.from('volunteer_access_codes')
    .select('id, code_hash, expires_at, attempts, consumed_at')
    .eq('contact_hash', ch).is('consumed_at', null)
    .order('created_at', { ascending: false }).limit(1);

  const row = (rows ?? [])[0];
  if (!row) return { ok: false, reason: 'none' };
  if (Date.parse(row.expires_at as string) < Date.now()) return { ok: false, reason: 'expired' };
  if ((row.attempts as number) >= MAX_ATTEMPTS) return { ok: false, reason: 'exhausted' };

  const expected = Buffer.from(row.code_hash as string, 'utf8');
  const given = Buffer.from(hashCode(contact, code), 'utf8');
  const match = expected.length === given.length && timingSafeEqual(expected, given);

  if (!match) {
    await service.from('volunteer_access_codes')
      .update({ attempts: (row.attempts as number) + 1 }).eq('id', row.id as string);
    return { ok: false, reason: (row.attempts as number) + 1 >= MAX_ATTEMPTS ? 'exhausted' : 'wrong' };
  }

  await service.from('volunteer_access_codes')
    .update({ consumed_at: new Date().toISOString() }).eq('id', row.id as string);
  return { ok: true };
}

/** Housekeeping: expired codes are worthless and should not linger. */
export async function purgeExpiredCodes(service: DB): Promise<number> {
  const { data } = await service.from('volunteer_access_codes')
    .delete().lt('expires_at', new Date(Date.now() - 86_400_000).toISOString()).select('id');
  return (data ?? []).length;
}
