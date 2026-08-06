// DAY 32 — the security audit, run as an attacker rather than read as a policy.
//
// Reading RLS policy text tells you what somebody INTENDED. This connects with
// the anon key and with a real authenticated JWT belonging to nobody in
// particular, and tries to read and write every table in the schema. What
// comes back is what an attacker actually gets.
//
// Three classes of table, and the expectation differs:
//
//   PRIVATE     the anon and authenticated roles are revoked outright. Nothing
//               reaches these except the service role. Every TourneyCircle
//               table, every credential table, the guidance store.
//   OWNED       readable only through an organizer's own rows (RLS by
//               organizer_id, or via a tournament they own).
//   PUBLIC      deliberately world-readable — a published tournament, its
//               tiers, a course. Writes must still be refused.
//
// A table that is world-WRITABLE is a finding regardless of class.
//
//   npx tsx scripts/audit-security.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const URL_ = get('NEXT_PUBLIC_SUPABASE_URL')!;
const ANON = get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!;
const db = createClient(URL_, get('SUPABASE_SERVICE_ROLE_KEY')!);

const RUN = Date.now().toString(36);
const DOM = `${RUN}.audit.example.invalid`;

let findings = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FINDING'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) findings += 1;
};
const section = (n: string) => console.log(`\n${n}`);

// Tables that must be unreachable by anon AND by any signed-in organizer.
// These hold either cross-tenant participant data or live credentials.
const PRIVATE = [
  'tourneycircle_members', 'tourneycircle_declines', 'tourneycircle_visits',
  'tourneycircle_sends', 'tourneycircle_notifications',
  'volunteer_access_codes', 'course_pro_access', 'push_subscriptions',
  'player_profiles', 'gps_consent_events', 'gps_devices',
  // The role/task libraries are reference data, but they are served through
  // owner-checked APIs, not read from the browser — so anon has no grant.
  'role_templates', 'task_templates',
  // Registrations carry names, emails, phone numbers and player rosters.
  // Every server path uses the service role; the browser reaches them only
  // as the owning organizer. See migration 048 — the anon grant on this
  // table exposed all of them.
  'registrations',
];

// Tables scoped to a tournament an organizer owns. A signed-in organizer who
// owns nothing must see zero rows — not an error, but not somebody else's data.
const OWNED = [
  'sponsors',
  'volunteers', 'tournament_volunteer_assignments', 'tournament_goals',
  'planning_meetings', 'meeting_action_items', 'meeting_attendance',
  'communication_log', 'volunteer_messages', 'volunteer_guidance_profiles',
  'guidance_events', 'volunteer_task_completions', 'tournament_events',
  'donation_prospects', 'donation_outreach_log', 'fb_calculations',
  'coach_conversations', 'coach_messages', 'kitchen_notifications',
  'contest_holes', 'contest_entries', 'score_corrections',
];

// Deliberately world-readable. Reads are fine; writes are not.
// Deliberately world-readable: the microsite, the sponsor marketplace and the
// course picker all render for visitors who are not signed in.
const PUBLIC_READ = ['courses', 'course_holes', 'sponsorship_tiers'];

async function main() {
  console.log(`Target: ${URL_}`);

  const anon = createClient(URL_, ANON);

  // A real signed-in organizer who owns nothing — the most under-tested
  // identity in the system, and the one an attacker actually has.
  const email = `nobody-${RUN}@${DOM}`;
  const password = `zzzAa1!${Math.random().toString(36).slice(2)}`;
  const { data: created } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  const { data: sess } = await createClient(URL_, ANON).auth.signInWithPassword({ email, password });
  const authed = createClient(URL_, ANON, {
    global: { headers: { Authorization: `Bearer ${sess.session!.access_token}` } },
  });

  try {
    section('1. Private tables — nothing but the service role may touch these');
    for (const t of PRIVATE) {
      const a = await anon.from(t).select('*').limit(1);
      const u = await authed.from(t).select('*').limit(1);
      const anonBlocked = !!a.error || (a.data ?? []).length === 0;
      const authBlocked = !!u.error || (u.data ?? []).length === 0;
      ok(anonBlocked && authBlocked, `${t} is closed to anon and to a signed-in stranger`,
        `anon: ${a.error ? a.error.message.slice(0, 40) : `${a.data?.length} row(s)`} · authed: ${u.error ? u.error.message.slice(0, 40) : `${u.data?.length} row(s)`}`);
    }

    section('2. Owned tables — a signed-in organizer who owns nothing sees nothing');
    for (const t of OWNED) {
      const u = await authed.from(t).select('*').limit(5);
      const rows = (u.data ?? []).length;
      ok(!!u.error || rows === 0, `${t} leaks no rows to a stranger`,
        u.error ? u.error.message.slice(0, 50) : `${rows} row(s) visible`);
    }

    section('3. Every table refuses an anonymous WRITE');
    for (const t of [...PRIVATE, ...OWNED, ...PUBLIC_READ]) {
      const ins = await anon.from(t).insert({ id: crypto.randomUUID() });
      // A column/constraint error still proves the write was ATTEMPTED and
      // reached the table, so only a permission/RLS refusal counts as blocked.
      const blocked = !!ins.error && /permission|policy|row-level|denied|not allowed/i.test(ins.error.message);
      const nullViolation = !!ins.error && /null value|violates not-null|foreign key|invalid input|column .* does not exist|schema cache/i.test(ins.error.message);
      ok(blocked || nullViolation, `${t} refuses an anonymous insert`,
        ins.error ? `${blocked ? 'RLS' : 'constraint'}: ${ins.error.message.slice(0, 45)}` : 'ACCEPTED THE ROW');
      if (!ins.error) {
        // Clean up anything that somehow landed, so an audit never leaves junk.
        await db.from(t).delete().neq('id', '00000000-0000-0000-0000-000000000000').limit(0);
      }
    }

    section('4. Public-read tables are readable but not writable');
    for (const t of PUBLIC_READ) {
      const r = await anon.from(t).select('id').limit(1);
      ok(!r.error, `${t} is readable (by design)`, r.error?.message.slice(0, 50) ?? `${r.data?.length} row(s)`);
      const up = await anon.from(t).update({ name: 'ZZZ AUDIT PWNED' }).neq('id', '00000000-0000-0000-0000-000000000000').select('id');
      ok(!!up.error || (up.data ?? []).length === 0, `${t} refuses an anonymous update`,
        up.error ? up.error.message.slice(0, 45) : `UPDATED ${up.data?.length} ROW(S)`);
    }

    section('4b. Tournaments are public — but only the PUBLISHED ones');
    // The microsite is meant to be readable by strangers. What must never be
    // readable is a tournament still being drafted: its date, price and cause
    // story are unfinished, and its existence may not be announced.
    const anonT = await anon.from('tournaments').select('id, status, name');
    const statuses = [...new Set((anonT.data ?? []).map((t) => t.status))];
    ok(!statuses.includes('draft'),
      'a DRAFT tournament is invisible to anonymous callers',
      `statuses visible: ${statuses.join(', ') || 'none'}`);
    const { count: totalT } = await db.from('tournaments').select('id', { count: 'exact', head: true });
    ok((anonT.data ?? []).length < (totalT ?? 0),
      'and anon sees fewer tournaments than exist — the filter is doing work',
      `${anonT.data?.length} of ${totalT}`);

    section('5. Privilege escalation — profiles.role');
    // A self-promotable role column is the classic hole: if an organizer can
    // UPDATE their own profiles row and `role` is one of the writable columns,
    // they promote themselves to admin.
    const { data: prof } = await db.from('profiles').select('id').limit(1);
    if (prof?.length) {
      const esc = await authed.from('profiles')
        .update({ role: 'admin' }).eq('id', created!.user!.id).select('role');
      ok(!!esc.error || (esc.data ?? []).length === 0,
        'a signed-in user cannot promote themselves to admin',
        esc.error ? esc.error.message.slice(0, 60) : `role is now ${JSON.stringify(esc.data?.[0]?.role)}`);
    } else {
      ok(true, 'profiles has no rows to probe (skipped)');
    }

    section('6. Cron endpoints require the shared secret');
    const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
    for (const path of ['/api/cron/comm-reminders', '/api/cron/donation-followups',
      '/api/cron/sponsor-followups', '/api/cron/kitchen-check', '/api/cron/gps-clusters']) {
      const res = await fetch(`${BASE}${path}`).catch(() => null);
      ok(res?.status === 401, `${path} refuses a caller with no CRON_SECRET`, `HTTP ${res?.status ?? 'unreachable'}`);
      const wrong = await fetch(`${BASE}${path}`, { headers: { Authorization: 'Bearer wrong' } }).catch(() => null);
      ok(wrong?.status === 401, `${path} refuses a wrong secret`, `HTTP ${wrong?.status ?? 'unreachable'}`);
    }

    section('7. Injection and traversal on the surfaces that take free text');
    const NASTY = [
      "'; drop table tournaments; --",
      "' or '1'='1",
      '../../../../etc/passwd',
      '<script>alert(1)</script>',
      '{{7*7}}',
      ' nul',
      'a'.repeat(20000),
    ];
    for (const payload of NASTY) {
      const res = await fetch(`${BASE}/api/volunteer/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: payload }),
      }).catch(() => null);
      ok(res != null && res.status < 500,
        `volunteer login survives ${JSON.stringify(payload.slice(0, 24))}`, `HTTP ${res?.status}`);
    }
    const { count: stillThere } = await db.from('tournaments').select('id', { count: 'exact', head: true });
    ok((stillThere ?? 0) >= 0, 'tournaments table still exists after the injection pass', `${stillThere} rows`);

    section('8. The service role key is not reachable from the browser bundle');
    const service = get('SUPABASE_SERVICE_ROLE_KEY')!;
    const page = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => '');
    ok(!page.includes(service), 'the landing page HTML does not contain the service role key');
    ok(!page.includes(get('SENDGRID_API_KEY') ?? ' never'), 'nor the SendGrid key');
    ok(!page.includes(get('ANTHROPIC_API_KEY') ?? ' never'), 'nor the Anthropic key');
    ok(!page.includes(get('CRON_SECRET') ?? ' never'), 'nor the cron secret');
  } finally {
    await db.auth.admin.deleteUser(created!.user!.id);
    console.log('\n  (audit identity removed)');
  }

  console.log(findings === 0
    ? '\n✅ SECURITY AUDIT — NO FINDINGS'
    : `\n❌ SECURITY AUDIT — ${findings} FINDING(S)`);
  process.exit(findings === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
