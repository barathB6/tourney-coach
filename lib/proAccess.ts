import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

// Server-only. Never import this from a 'use client' module — it would leak
// the hashing routine into the browser bundle.

const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

export const SESSION_TTL_HOURS = 12;

// The issued password, in the format the organizer tells the pro over the
// phone: the course name with spaces stripped, plus the tournament year.
// "St. Michael's Golf Club" + 2026 -> "St.Michaels2026"
export function issuedPassword(courseName: string, year: number): string {
  const cleaned = courseName
    .normalize('NFKD')
    .replace(/[^\w.\s-]/g, '')  // drop apostrophes/punctuation, keep dots
    .replace(/\s+/g, '')
    .trim();
  return `${cleaned || 'Course'}${year}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const newLinkToken = () => randomUUID().replace(/-/g, '') + randomBytes(8).toString('hex');
export const newSessionToken = () => randomUUID() + randomBytes(16).toString('hex');
export const sessionExpiry = () => new Date(Date.now() + SESSION_TTL_HOURS * 3600_000).toISOString();

// Emails are compared case-insensitively and trimmed — a pro typing "Pat@Club.com"
// on a grant issued to "pat@club.com" is the same person.
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// Short, non-reversible fingerprint for logging a login attempt without ever
// writing the link token itself to logs.
export const tokenFingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 12);
