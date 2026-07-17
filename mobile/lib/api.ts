import { supabase } from './supabase';
import { config } from './config';

// Calls a Next.js API route on the production backend, attaching the current
// Supabase access token as a Bearer header — exactly how the web client
// authenticates to the same endpoints (e.g. /api/registrations/[id]/checkin).
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

  const res = await fetch(`${config.apiBaseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body as T;
}
