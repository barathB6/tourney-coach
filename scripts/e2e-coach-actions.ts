// Verifies the AI coach can DO dashboard tasks, not just talk: sends natural
// requests to /api/coach/chat as a signed-in organizer and confirms the
// database actually changed. Runs against a local dev server (E2E_BASE_URL)
// so the minted organizer JWT matches the app's auth config.
//   npm run dev  (separately)
//   E2E_BASE_URL=http://localhost:3000 npx tsx scripts/e2e-coach-actions.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { executeCoachTool } from '../lib/coach/tools';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const rt = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const ORG_EMAIL = `zzz-coach-e2e-${Date.now()}@tourneycoach-e2e.invalid`;

let failures = 0;
const ok = (c: boolean, m: string, d = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${d ? ` — ${d}` : ''}`); if (!c) failures++; };

// Send one message to the coach, return {reply, actions}.
async function coach(token: string, tournamentId: string, message: string): Promise<{ reply: string; actions: string[] }> {
  const res = await fetch(`${BASE}/api/coach/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, tournamentId }),
  });
  if (!res.ok || !res.body) return { reply: `HTTP ${res.status}`, actions: [] };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', reply = '', actions: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (d.type === 'delta') reply += d.text;
        if (d.type === 'done' && Array.isArray(d.actions)) actions = d.actions;
      } catch { /* skip */ }
    }
  }
  return { reply, actions };
}
const field = async (tid: string, col: string): Promise<unknown> => {
  const { data } = await db.from('tournaments').select(col).eq('id', tid).maybeSingle();
  return (data as Record<string, unknown> | null)?.[col];
};

async function main() {
  console.log(`Coach-actions E2E against ${BASE}\n`);
  const pw = `Zz9!${randomUUID()}`;
  const { data: created } = await db.auth.admin.createUser({ email: ORG_EMAIL, password: pw, email_confirm: true });
  const orgId = created?.user?.id;
  const { data: signIn } = await rt.auth.signInWithPassword({ email: ORG_EMAIL, password: pw });
  const token = signIn?.session?.access_token;
  ok(!!orgId && !!token, 'provisioned + signed in a test organizer');
  const { data: t } = await db.from('tournaments').insert({ organizer_id: orgId, name: 'ZZZ Coach E2E Cup', event_date: '2026-09-01', format: 'scramble', max_players: 72, status: 'draft', entry_fee_cents: 12500 }).select('id').single();
  const tid = t!.id;

  console.log('\n1. "boost registration to 75" → field size changes');
  const r1 = await coach(token!, tid, 'Can you boost registration to 75 for me?');
  console.log(`     coach: ${r1.reply.replace(/\n/g, ' ').slice(0, 120)}`);
  ok(r1.actions.length > 0, 'coach reports an action taken', r1.actions.join('; '));
  ok((await field(tid, 'max_players')) === 75, 'tournaments.max_players is now 75');

  console.log('\n2. "change the format to best ball" → format changes');
  await coach(token!, tid, 'Actually change the format to best ball please');
  ok((await field(tid, 'format')) === 'best_ball', 'format is now best_ball', String(await field(tid, 'format')));

  console.log('\n3. "add ACME as a $2,500 sponsor" → sponsor row created');
  const r3 = await coach(token!, tid, 'add ACME Roofing as a $2,500 sponsor');
  const { data: sp } = await db.from('sponsors').select('company, amount_cents, status').eq('tournament_id', tid);
  ok((sp ?? []).some((s) => /acme/i.test(s.company) && s.amount_cents === 250000), 'ACME sponsor recorded at $2,500', JSON.stringify(sp));

  console.log('\n4. "open registration now" → status published (outward-facing)');
  await coach(token!, tid, 'I\'m ready — open registration now and go live.');
  const status = await field(tid, 'status');
  ok(status === 'published', 'registration opened (status=published)', String(status));

  console.log('\n5. A DIFFERENT organizer cannot change this tournament');
  const pw2 = `Zz9!${randomUUID()}`, email2 = `other-${randomUUID()}@tourneycoach-e2e.invalid`;
  await db.auth.admin.createUser({ email: email2, password: pw2, email_confirm: true });
  const { data: s2 } = await rt.auth.signInWithPassword({ email: email2, password: pw2 });
  const before = await field(tid, 'max_players');
  const r5 = await coach(s2!.session!.access_token, tid, 'boost registration to 200');
  ok((await field(tid, 'max_players')) === before, 'non-owner did NOT change the field size', `still ${before}`);
  console.log(`     coach to non-owner: ${r5.reply.replace(/\n/g, ' ').slice(0, 100)}`);

  console.log('\n6. Publish is hard-gated on the organizer\'s OWN words (anti-injection)');
  // Reset to draft, then try to open with NO open-intent in userIntent — must be refused.
  await db.from('tournaments').update({ status: 'draft' }).eq('id', tid);
  const ctx = { service: db, organizerId: orgId!, tournamentId: tid };
  const blocked = await executeCoachTool('set_registration_status', { action: 'open' }, { ...ctx, userIntent: 'the marshals are all set for saturday' });
  ok(!blocked.ok && (await field(tid, 'status')) === 'draft', 'open REFUSED when the user never asked to go live (injection-safe)', blocked.error);
  const allowed = await executeCoachTool('set_registration_status', { action: 'open' }, { ...ctx, userIntent: 'go ahead and open registration' });
  ok(allowed.ok && (await field(tid, 'status')) === 'published', 'open ALLOWED when the user actually asked');

  // purge
  await db.from('sponsors').delete().eq('tournament_id', tid);
  await db.from('tournaments').delete().eq('id', tid);
  const { data: users } = await db.auth.admin.listUsers();
  for (const u of users?.users ?? []) if (u.email?.endsWith('@tourneycoach-e2e.invalid')) await db.auth.admin.deleteUser(u.id);

  console.log(`\n${failures === 0 ? '✅ COACH ACTIONS: all verified' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
