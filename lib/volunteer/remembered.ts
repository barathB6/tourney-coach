// Remembering a volunteer on their own device.
//
// Once somebody has proved they control the email or phone, making them do it
// again on the same phone next week is pointless friction — the token is
// already in their text messages anyway. So the roles they verified are kept
// locally and offered as a one-tap door.
//
// This is localStorage, not a cookie: it must never travel to the server on
// every request, and it is per-device by design. Anyone with the unlocked
// phone can already read the invitation text, so this widens nothing.

export interface RememberedRole {
  token: string;
  tournamentName: string;
  roleName: string;
  volunteerName: string;
  eventDate: string | null;
  status: string;
}

const KEY = 'tc_volunteer_roles';
/** Roles are forgotten a while after the event — a phone should not carry a
 * credential for a tournament that finished last season. */
const KEEP_DAYS_AFTER_EVENT = 30;

interface Stored { roles: RememberedRole[]; savedAt: string }

export function readRemembered(): RememberedRole[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Stored;
    const cutoff = Date.now() - KEEP_DAYS_AFTER_EVENT * 86_400_000;
    const live = (parsed.roles ?? []).filter((r) => {
      if (!r.eventDate) return true;
      const t = Date.parse(`${r.eventDate.slice(0, 10)}T12:00:00Z`);
      return Number.isNaN(t) || t > cutoff;
    });
    // Prune on read so a stale credential does not sit there indefinitely.
    if (live.length !== (parsed.roles ?? []).length) writeRemembered(live);
    return live;
  } catch { return []; }
}

function writeRemembered(roles: RememberedRole[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ roles, savedAt: new Date().toISOString() } satisfies Stored));
  } catch { /* private mode — sign-in still works, it just will not be remembered */ }
}

/** Merge freshly-verified roles in, replacing any entry with the same token. */
export function rememberRoles(roles: RememberedRole[]): void {
  const existing = readRemembered();
  const byToken = new Map(existing.map((r) => [r.token, r]));
  for (const r of roles) byToken.set(r.token, r);
  writeRemembered([...byToken.values()]);
}

export function forgetAll(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
