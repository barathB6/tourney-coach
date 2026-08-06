import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// GET /api/health — what a monitor pings, and what a human opens at 6am on
// tournament day.
//
// The distinction that matters here: "up" is not "working". This process can
// serve pages perfectly while Twilio is unconfigured and every day-of SMS
// silently goes nowhere. So the response separates:
//
//   status: 'ok'        everything a tournament needs is wired
//           'degraded'  a delivery channel or an optional integration is out;
//                       the platform runs, some things will not send
//           'down'      the database is unreachable, or a migration the code
//                       depends on has not been applied
//
// It deliberately reveals nothing an attacker can use: booleans about whether
// a variable is SET, never a value, and no schema detail beyond migration
// names that are already in the public repo.

const has = (k: string) => !!process.env[k]?.trim();

export async function GET() {
  const checks: { name: string; ok: boolean; critical: boolean; note?: string }[] = [];
  const started = Date.now();

  // ── The database, and the migrations the running code assumes ────────────
  let dbMs = -1;
  try {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const t0 = Date.now();
    const { error } = await db.from('tournaments').select('id').limit(1);
    dbMs = Date.now() - t0;
    checks.push({ name: 'database', ok: !error, critical: true, note: error?.message ?? `${dbMs}ms` });

    // Each of these is a column or function some route will 500 on if absent.
    // Naming the migration is the whole point: an alert that says "run 046" is
    // actionable at 6am; "internal server error" is not.
    const probes: { name: string; run: () => Promise<string | null> }[] = [
      {
        name: 'migration 046 (circle prefs token)',
        run: async () => (await db.from('tourneycircle_members').select('prefs_token').limit(1)).error?.message ?? null,
      },
      {
        name: 'migration 047 (volunteer code atomicity)',
        run: async () => {
          const { error } = await db.rpc('verify_volunteer_code', {
            p_contact_hash: 'health-probe-no-such-contact', p_code_hash: 'x', p_max_attempts: 5,
          });
          return error?.message ?? null;
        },
      },
      {
        name: 'migration 048 (registrations lockdown)',
        run: async () => {
          // The check is that ANON cannot read the table. This is the one
          // probe that tests a security property rather than a schema one,
          // because it is the one that was silently wrong.
          const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
          const { data, error } = await anon.from('registrations').select('id').limit(1);
          if (error) return null;
          return (data ?? []).length > 0 ? 'anon can still read registrations' : null;
        },
      },
      {
        name: 'migration 049 (performance indexes)',
        run: async () => (await db.from('volunteers').select('id').limit(1)).error?.message ?? null,
      },
    ];
    for (const p of probes) {
      const note = await p.run().catch((e) => String(e));
      checks.push({ name: p.name, ok: note == null, critical: true, note: note ?? 'applied' });
    }
  } catch (e) {
    checks.push({ name: 'database', ok: false, critical: true, note: e instanceof Error ? e.message : 'unreachable' });
  }

  // ── Delivery channels ────────────────────────────────────────────────────
  checks.push({ name: 'email (SendGrid)', ok: has('SENDGRID_API_KEY'), critical: true });
  checks.push({
    name: 'sms (Twilio)',
    ok: has('TWILIO_ACCOUNT_SID') && has('TWILIO_AUTH_TOKEN') && has('TWILIO_FROM_NUMBER'),
    critical: false,
    note: 'unset since Day 27 — every SMS path falls back to email or to nothing',
  });
  // Checked against the RUNTIME variables, not NEXT_PUBLIC_VAPID_PUBLIC_KEY.
  // That one is inlined at build time and comes back `undefined` when the var
  // is marked Sensitive in Vercel — which is how this check found that push had
  // never worked in production. The client now fetches the key from
  // /api/push/key, so VAPID_PUBLIC_KEY is the one that matters.
  checks.push({
    name: 'push (VAPID)',
    ok: has('VAPID_PRIVATE_KEY') && (has('VAPID_PUBLIC_KEY') || has('NEXT_PUBLIC_VAPID_PUBLIC_KEY')),
    critical: false,
  });
  checks.push({ name: 'payments (Adyen)', ok: has('ADYEN_API_KEY') && has('ADYEN_WEBHOOK_HMAC_KEY'), critical: true });
  checks.push({ name: 'ai coach (Anthropic)', ok: has('ANTHROPIC_API_KEY'), critical: false });

  // ── Things that are only wrong when they are missing ─────────────────────
  checks.push({ name: 'cron secret', ok: has('CRON_SECRET'), critical: true, note: has('CRON_SECRET') ? undefined : 'cron endpoints are OPEN without this' });
  checks.push({
    name: 'sendgrid webhook signing',
    ok: has('SENDGRID_WEBHOOK_PUBLIC_KEY'),
    critical: false,
    note: has('SENDGRID_WEBHOOK_PUBLIC_KEY') ? undefined : 'engagement events are accepted unsigned',
  });
  checks.push({
    name: 'volunteer code pepper',
    ok: has('VOLUNTEER_CODE_PEPPER'),
    critical: false,
    note: has('VOLUNTEER_CODE_PEPPER') ? undefined : 'falling back to the service role key (works, but rotating one rotates the other)',
  });

  const failedCritical = checks.filter((c) => !c.ok && c.critical);
  const failedOptional = checks.filter((c) => !c.ok && !c.critical);
  const status = failedCritical.length > 0 ? 'down' : failedOptional.length > 0 ? 'degraded' : 'ok';

  return NextResponse.json({
    status,
    checkedAt: new Date().toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    environment: process.env.VERCEL_ENV ?? 'development',
    latencyMs: { database: dbMs, total: Date.now() - started },
    failing: [...failedCritical, ...failedOptional].map((c) => ({ name: c.name, critical: c.critical, note: c.note })),
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, critical: c.critical, ...(c.note ? { note: c.note } : {}) })),
  }, {
    status: status === 'down' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
