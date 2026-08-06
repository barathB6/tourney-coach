// Error tracking and operational events.
//
// Deliberately not a Sentry SDK import. Three reasons: this runs on Vercel
// where stdout is already collected and searchable, a golf tournament's error
// volume does not justify a vendor dependency in the hot path, and — the one
// that actually decides it — an SDK that needs a DSN fails silently when the
// DSN isn't set, which is exactly the failure mode you cannot afford in the
// thing that tells you about failures.
//
// So: structured JSON to stdout ALWAYS, and a best-effort POST to Sentry's
// plain HTTP store endpoint when SENTRY_DSN is configured. If the vendor is
// down, or unconfigured, the log line is still there.
//
// What gets reported is chosen for a beta tournament that runs one Saturday a
// year: the things that silently cost money or silently drop a message.

export type Severity = 'error' | 'warning' | 'info';

export interface ReportContext {
  /** Where it happened: 'cron.sponsor-followups', 'comm.send', 'payments.adyen'. */
  scope: string;
  tournamentId?: string | null;
  /** Anything else worth having at 6am on tournament day. No PII. */
  detail?: Record<string, unknown>;
}

const REDACT = /(key|token|secret|password|authorization|pepper|dsn)/i;

// Nothing reported here should carry a credential or a person. Scrub by key
// name, and truncate — a 40KB provider error body helps nobody.
function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? '[redacted]' : scrub(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

interface SentryDsn { host: string; projectId: string; publicKey: string; protocol: string }

function parseDsn(raw: string): SentryDsn | null {
  // https://<publicKey>@<host>/<projectId>
  const m = raw.trim().match(/^(https?):\/\/([^@]+)@([^/]+)\/(\d+)$/);
  return m ? { protocol: m[1], publicKey: m[2], host: m[3], projectId: m[4] } : null;
}

async function toSentry(level: Severity, message: string, ctx: ReportContext, stack?: string) {
  const raw = process.env.SENTRY_DSN?.trim();
  if (!raw) return;
  const dsn = parseDsn(raw);
  if (!dsn) return;

  const body = {
    level: level === 'warning' ? 'warning' : level,
    platform: 'node',
    logger: ctx.scope,
    environment: process.env.VERCEL_ENV ?? 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    message: { formatted: message },
    tags: { scope: ctx.scope, ...(ctx.tournamentId ? { tournament_id: ctx.tournamentId } : {}) },
    extra: scrub(ctx.detail ?? {}),
    ...(stack ? { exception: { values: [{ type: 'Error', value: message, stacktrace: { frames: [] } }] } } : {}),
  };

  // Never let reporting an error throw one, and never let it hang a request.
  await fetch(`${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=tourneycoach/1`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  }).catch(() => { /* the stdout line above is the record of last resort */ });
}

function emit(level: Severity, message: string, ctx: ReportContext, stack?: string) {
  // One line, parseable. Vercel's log drain and `vercel logs` both grep this.
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    scope: ctx.scope,
    msg: message,
    ...(ctx.tournamentId ? { tournamentId: ctx.tournamentId } : {}),
    ...(ctx.detail ? { detail: scrub(ctx.detail) } : {}),
    ...(stack ? { stack: stack.split('\n').slice(0, 8).join(' | ') } : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warning') console.warn(line);
  else console.log(line);
}

/** Something broke. Use for anything that costs money or drops a message. */
export function captureError(err: unknown, ctx: ReportContext): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  emit('error', message, ctx, stack);
  void toSentry('error', message, ctx, stack);
}

/** Not broken, but somebody should look — a degraded path, a fallback taken. */
export function captureWarning(message: string, ctx: ReportContext): void {
  emit('warning', message, ctx);
  void toSentry('warning', message, ctx);
}

/** An operational fact worth being able to search for after the fact. */
export function captureEvent(message: string, ctx: ReportContext): void {
  emit('info', message, ctx);
}

/**
 * Wrap a cron handler so a thrown error is reported rather than returned as an
 * opaque 500 that nobody reads. Vercel retries nothing, so an unreported cron
 * failure is a silent, permanent miss — the sponsor follow-up that never went.
 */
export async function withCronReporting<T>(
  scope: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const result = await fn();
    captureEvent('cron completed', { scope, detail: { ms: Date.now() - started } });
    return { ok: true, result };
  } catch (err) {
    captureError(err, { scope, detail: { ms: Date.now() - started } });
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
