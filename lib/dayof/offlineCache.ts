// Offline support for the volunteer app.
//
// The volunteer who most needs this app is standing on the 14th tee with one
// bar of signal. So: every successful snapshot is written to localStorage, and
// a failed fetch falls back to it rather than to a spinner. Actions taken
// offline (ticking a task, sending a message) are queued and replayed when the
// connection returns.
//
// This is deliberately localStorage rather than IndexedDB — the payload is a
// few KB of one volunteer's own tasks, and localStorage is synchronous, which
// means the cached screen paints on the FIRST render rather than after a
// promise resolves. On a bad connection that difference is the whole point.

const KEY = (token: string) => `tc_v_${token}`;
const QUEUE = (token: string) => `tc_vq_${token}`;

export interface CachedSnapshot<T> {
  data: T;
  cachedAt: string;
}

export function readCache<T>(token: string): CachedSnapshot<T> | null {
  try {
    const raw = localStorage.getItem(KEY(token));
    return raw ? (JSON.parse(raw) as CachedSnapshot<T>) : null;
  } catch { return null; }
}

export function writeCache<T>(token: string, data: T): void {
  try {
    localStorage.setItem(KEY(token), JSON.stringify({ data, cachedAt: new Date().toISOString() }));
  } catch { /* quota or private mode — the app still works online */ }
}

export interface QueuedAction {
  id: string;
  body: Record<string, unknown>;
  queuedAt: string;
}

export function readQueue(token: string): QueuedAction[] {
  try {
    const raw = localStorage.getItem(QUEUE(token));
    return raw ? (JSON.parse(raw) as QueuedAction[]) : [];
  } catch { return []; }
}

export function enqueue(token: string, body: Record<string, unknown>): QueuedAction {
  const action: QueuedAction = {
    // Not crypto.randomUUID — some older mobile browsers on http origins do
    // not expose it, and a queue id only has to be locally unique.
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    body,
    queuedAt: new Date().toISOString(),
  };
  const q = readQueue(token);
  q.push(action);
  try { localStorage.setItem(QUEUE(token), JSON.stringify(q)); } catch { /* ignore */ }
  return action;
}

export function dequeue(token: string, id: string): void {
  const q = readQueue(token).filter((a) => a.id !== id);
  try { localStorage.setItem(QUEUE(token), JSON.stringify(q)); } catch { /* ignore */ }
}

/**
 * Replay everything queued while offline, oldest first. Order matters: a task
 * ticked and then un-ticked must not end up ticked. An action that fails with
 * a 4xx is dropped rather than retried forever — the server rejected it on
 * its merits and it will be rejected again.
 */
export async function flushQueue(
  token: string,
  send: (body: Record<string, unknown>) => Promise<Response>,
): Promise<{ sent: number; dropped: number; remaining: number }> {
  let sent = 0;
  let dropped = 0;
  for (const action of readQueue(token)) {
    try {
      const res = await send(action.body);
      if (res.ok) { dequeue(token, action.id); sent++; }
      else if (res.status >= 400 && res.status < 500) { dequeue(token, action.id); dropped++; }
      else break; // server-side problem — stop and keep the rest for later
    } catch {
      break; // still offline
    }
  }
  return { sent, dropped, remaining: readQueue(token).length };
}
