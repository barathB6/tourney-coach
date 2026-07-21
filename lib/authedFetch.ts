'use client';

import { supabase } from '@/lib/supabaseClient';

// Central fetch for authenticated API routes. Exists because a cached
// access token can outlive its server-side session (signing in on another
// device/app invalidates the old session; the JWT isn't expired, but any
// route calling auth.getUser rejects it with 401 "session_not_found").
// Pages that called fetch with a raw Bearer token dead-ended on
// "Unauthorized" errors when that happened.
//
// Behavior: attach the current session's token; on 401, refresh the session
// once and retry; if still 401 the session is truly dead — clear the stale
// local session (otherwise /sign-in bounces straight back and loops) and
// redirect to sign-in with a return path.
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    redirectToSignIn();
    return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401 });
  }

  const doFetch = (token: string) =>
    fetch(input, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });

  let res = await doFetch(session.access_token);
  if (res.status === 401) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed.session) res = await doFetch(refreshed.session.access_token);
    if (res.status === 401) {
      await supabase.auth.signOut({ scope: 'local' });
      redirectToSignIn();
    }
  }
  return res;
}

function redirectToSignIn() {
  if (typeof window !== 'undefined') {
    window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`);
  }
}
