// Base URL for links that appear in emails or other externally-delivered
// content. Unlike `process.env.NEXT_PUBLIC_APP_URL` directly, this never
// returns a localhost URL — those get baked in whenever a real email is sent
// from a dev (or misconfigured) environment, producing dead links in the
// recipient's inbox. Falls back to the canonical production domain.
export function getPublicAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '');
  if (configured && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(configured)) {
    return configured;
  }
  return 'https://www.tourneycoach.com';
}
