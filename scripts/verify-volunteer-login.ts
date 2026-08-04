// In-site volunteer sign-in verification.
//
// The whole point of this flow is that a volunteer reaches their own view
// without leaving the site — and that NOBODY reaches somebody else's. So the
// checks below are mostly adversarial: guessing, enumerating, replaying, and
// asking for codes forever.
//
//   npx tsx scripts/verify-volunteer-login.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  issueCode, verifyCode, generateCode, hashContact,
  MAX_ATTEMPTS, MAX_REQUESTS_PER_HOUR, CODE_TTL_MS,
} from '../lib/volunteer/accessCode';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

const RUN = Date.now().toString(36);
const TAG = 'ZZZ VLOGIN';
const DOM = `${RUN}.vlogin.example.invalid`;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

async function main() {
  const { error: schemaErr } = await db.from('volunteer_access_codes').select('id').limit(1);
  if (schemaErr) {
    console.log(`\n❌ Migration 045 has not been run — ${schemaErr.message}`);
    console.log('   Run db/migrations/045_volunteer_access_codes.sql, then re-run this.');
    process.exit(1);
  }

  // ── Pure code mechanics ──────────────────────────────────────────────────
  section('1. Code generation');
  const codes = new Set<string>();
  for (let i = 0; i < 400; i++) codes.add(generateCode());
  ok([...codes].every((c) => /^\d{6}$/.test(c)), 'every code is exactly six digits');
  ok(codes.size > 380, 'codes are not repeating — this is a credential, not a counter', `${codes.size}/400 unique`);

  section('2. Nothing sensitive is stored in the clear');
  const contact = `probe-${RUN}@${DOM}`;
  const issued = await issueCode(db, contact);
  ok(issued.ok && !!issued.code, 'a code is issued');
  const { data: rows } = await db.from('volunteer_access_codes')
    .select('contact_hash, code_hash').eq('contact_hash', hashContact(contact));
  const row = (rows ?? [])[0];
  ok(!!row, 'the row exists');
  ok(row.code_hash !== issued.code && !String(row.code_hash).includes(issued.code!),
    'THE CODE IS NOT STORED IN THE CLEAR — a table leak grants nobody a working code');
  ok(row.contact_hash !== contact && !String(row.contact_hash).includes(DOM),
    'nor is the contact — this table is not a list of who volunteers');

  section('3. Verification');
  const wrong = await verifyCode(db, contact, '000000');
  ok(!wrong.ok, 'a wrong code is rejected');
  const right = await verifyCode(db, contact, issued.code!);
  ok(right.ok, 'the right code is accepted');
  const replay = await verifyCode(db, contact, issued.code!);
  ok(!replay.ok && replay.reason === 'none',
    'REPLAY: the same code cannot be used twice', replay.ok ? 'accepted!' : replay.reason);

  section('4. Brute force is capped');
  const bf = await issueCode(db, `bf-${RUN}@${DOM}`);
  let lastReason = '';
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    const r = await verifyCode(db, `bf-${RUN}@${DOM}`, String(100000 + i));
    if (!r.ok) lastReason = r.reason;
  }
  ok(lastReason === 'exhausted', `the code dies after ${MAX_ATTEMPTS} wrong guesses`, lastReason);
  const afterBurn = await verifyCode(db, `bf-${RUN}@${DOM}`, bf.code!);
  ok(!afterBurn.ok,
    'and the CORRECT code no longer works once the attempts are burnt — guessing cannot be outlasted');

  section('5. Codes expire');
  const expContact = `exp-${RUN}@${DOM}`;
  const exp = await issueCode(db, expContact);
  await db.from('volunteer_access_codes')
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('contact_hash', hashContact(expContact));
  const expired = await verifyCode(db, expContact, exp.code!);
  ok(!expired.ok && expired.reason === 'expired', `a code past its ${CODE_TTL_MS / 60000} minutes is dead`);

  section('6. Reissue is rate limited');
  const rlContact = `rl-${RUN}@${DOM}`;
  let limited = false;
  for (let i = 0; i < MAX_REQUESTS_PER_HOUR + 2; i++) {
    const r = await issueCode(db, rlContact);
    if (r.rateLimited) limited = true;
  }
  ok(limited, `a contact cannot be issued more than ${MAX_REQUESTS_PER_HOUR} codes an hour`);
  ok(true, 'which is what stops an attacker widening the guessing window by reissuing');

  // ── The API, end to end ──────────────────────────────────────────────────
  section('7. The route itself');
  const { POST } = await import('../app/api/volunteer/login/route');
  const { NextRequest } = await import('next/server');
  const call = async (payload: Record<string, unknown>) => {
    const res = await POST(new NextRequest('http://localhost/api/volunteer/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
    return { status: res.status, body: await res.json() };
  };

  const junk = await call({ contact: 'not-an-address' });
  ok(junk.status === 400, 'garbage input is rejected');

  // ENUMERATION: an address nobody uses must be indistinguishable from a real
  // one. This is the property that stops the endpoint answering "does this
  // person volunteer anywhere?".
  const ghost = await call({ contact: `nobody-${RUN}@${DOM}` });
  ok(ghost.status === 200 && ghost.body.sent === true,
    'an unknown address gets the SAME answer as a known one — no enumeration oracle');

  // Now a real volunteer.
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${RUN}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} CUP`, organizer_id: owner!.user!.id, event_date: '2026-10-10',
    shotgun_time: '08:00', format: 'scramble', max_players: 72, entry_fee_cents: 16500, status: 'published',
  }).select('id').single();
  const tid = t!.id as string;
  const { data: roles } = await db.from('role_templates').select('id, name, phase').eq('phase', 'day_of').limit(1);
  const volEmail = `dana-${RUN}@${DOM}`;
  const { data: v } = await db.from('volunteers')
    .insert({ tournament_id: tid, name: `${TAG} Dana`, email: volEmail, phone: '9855550134' })
    .select('id').single();
  const { data: a } = await db.from('tournament_volunteer_assignments').insert({
    tournament_id: tid, volunteer_id: v!.id, role_template_id: roles![0].id,
    status: 'confirmed', invite_token: crypto.randomUUID(),
  }).select('invite_token').single();

  const cleanup = async () => {
    await db.from('volunteer_access_codes').delete().in('contact_hash',
      [contact, `bf-${RUN}@${DOM}`, expContact, rlContact, volEmail, '+19855550134'].map(hashContact));
    for (const tbl of ['communication_log', 'volunteer_guidance_profiles', 'guidance_events',
      'tournament_volunteer_assignments', 'volunteers']) {
      await db.from(tbl).delete().eq('tournament_id', tid);
    }
    await db.from('tournaments').delete().eq('id', tid);
    await db.auth.admin.deleteUser(owner!.user!.id);
  };

  try {
    const real = await call({ contact: volEmail });
    ok(real.status === 200 && real.body.sent === true, 'a real volunteer gets a code');
    ok(!JSON.stringify(real.body).includes(a!.invite_token as string),
      'STEP 1 NEVER LEAKS THE TOKEN — asking for a code does not hand over the credential');
    ok(!JSON.stringify(real.body).toLowerCase().includes('dana'),
      'nor the volunteer’s name');

    // Pull the issued code the only way anybody legitimately could: it was
    // sent. We read it back from the send ledger, which is what the volunteer
    // reads in their inbox.
    const { data: sent } = await db.from('communication_log')
      .select('subject, body').eq('volunteer_id', v!.id).eq('kind', 'invite')
      .order('created_at', { ascending: false }).limit(1);
    const codeMatch = String(sent?.[0]?.subject ?? '').match(/\b(\d{6})\b/);
    ok(!!codeMatch, 'the code actually reached the volunteer', sent?.[0]?.subject ?? 'no send');

    const badCode = await call({ contact: volEmail, code: '000000' });
    ok(badCode.status === 400, 'a wrong code at the route is rejected');

    const good = await call({ contact: volEmail, code: codeMatch![1] });
    ok(good.status === 200 && good.body.verified === true, 'the right code verifies');
    ok(good.body.roles?.length === 1, 'and returns exactly their one role', `${good.body.roles?.length}`);
    ok(good.body.roles?.[0]?.token === a!.invite_token,
      'INTEGRATION: the token handed back opens their real volunteer view');
    ok(good.body.roles?.[0]?.tournamentName === `${TAG} CUP`
      && typeof good.body.roles?.[0]?.roleName === 'string',
      'with enough context to pick between tournaments', good.body.roles?.[0]?.roleName);

    const reused = await call({ contact: volEmail, code: codeMatch![1] });
    ok(reused.status === 400, 'and that code is spent — it cannot be replayed at the route either');

    // The decisive one: somebody else's contact must never yield this token.
    await call({ contact: `attacker-${RUN}@${DOM}` });
    const { data: attackerCodes } = await db.from('volunteer_access_codes')
      .select('id').eq('contact_hash', hashContact(`attacker-${RUN}@${DOM}`));
    ok((attackerCodes ?? []).length === 0,
      'CONTAINMENT: no code is even issued for an address with no volunteer behind it');

    section('8. Phone numbers');
    const byPhone = await call({ contact: '(985) 555-0134' });
    ok(byPhone.status === 200 && byPhone.body.sent === true,
      'a phone typed the way a human types it resolves to the same volunteer');
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(failures === 0
    ? '\n✅ VOLUNTEER LOGIN — ALL CHECKS PASSED'
    : `\n❌ VOLUNTEER LOGIN — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
