// Verifies offline scoring with LATER SYNC is correct — specifically that a
// score entered offline and synced late keeps its ENTRY-TIME ordering (so it
// can't leapfrog a score the team entered afterward), and that a client can't
// forge arbitrary timestamps. Exercises the real deployed /api/gps/score.
//   npx tsx scripts/e2e-offline-score.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';
const T_NAME = 'ZZZ OFFLINE SCORE TEST — SAFE TO DELETE';
const COURSE = 'ZZZ OFFLINE COURSE — SAFE TO DELETE';

let failures = 0;
const ok = (c: boolean, m: string, d = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${d ? ` — ${d}` : ''}`); if (!c) failures++; };
const api = (body: unknown) => fetch(`${BASE}/api/gps/score`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const board = async (tid: string) => (await (await fetch(`${BASE}/api/tournament/${tid}/board`, { cache: 'no-store' } as RequestInit)).json()).standings?.[0];
const storedAt = async (regId: string, hole: number) => (await db.from('score_submissions').select('submitted_at').eq('registration_id', regId).eq('hole_number', hole).order('submitted_at', { ascending: false }).limit(1).maybeSingle()).data?.submitted_at as string | undefined;

async function main() {
  console.log(`Offline-score sync test against ${BASE}\n`);
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const { data: course } = await db.from('courses').insert({ name: COURSE, city: 'T', state: 'CA', total_holes: 18, organizer_id: anyT?.organizer_id, profile_status: 'complete' }).select('id').single();
  await db.from('course_holes').insert([{ course_id: course!.id, hole_number: 1, par: 4 }, { course_id: course!.id, hole_number: 2, par: 3 }]);
  const { data: t } = await db.from('tournaments').insert({ organizer_id: anyT?.organizer_id, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: course!.id, format: 'scramble', max_score_rule: 'none', status: 'live' }).select('id').single();
  const tid = t!.id;
  const { data: reg } = await db.from('registrations').insert({ tournament_id: tid, registration_type: 'foursome', team_name: 'Offline Team', contact_name: 'Cap', contact_email: 'o@tourneycoach.com', total_amount_cents: 0, payment_status: 'pending', foursome_number: 1, players: [] }).select('id').single();
  const token = randomUUID();
  await fetch(`${BASE}/api/gps/consent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ registrationId: reg!.id, deviceToken: token, playerName: 'Cap' }) });

  console.log('1. A score synced late keeps its ENTRY time (submitted_at ≈ enteredAt)');
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  await api({ deviceToken: token, holeNumber: 2, strokes: 2, enteredAt: tenMinAgo });
  const at = await storedAt(reg!.id, 2);
  ok(!!at && Math.abs(Date.parse(at) - Date.parse(tenMinAgo)) < 2000, 'stored submitted_at matches the offline entry time', at);

  console.log('\n2. A late-synced offline score does NOT leapfrog a later-entered score');
  // Team plays hole 1 = 6 now (online). THEN an offline score of 3 entered
  // 20 min ago finally syncs. The 6 (entered later) must still win.
  await api({ deviceToken: token, holeNumber: 1, strokes: 6, enteredAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 400));
  await api({ deviceToken: token, holeNumber: 1, strokes: 3, enteredAt: new Date(Date.now() - 20 * 60_000).toISOString() }); // late sync of an EARLIER entry
  await new Promise((r) => setTimeout(r, 600));
  const s = await board(tid);
  // hole1=6 (+2), hole2=2 (par3, -1) → +1 total if the 6 correctly wins.
  ok(s?.toPar === 1, 'leaderboard keeps the later-entered 6, not the late-synced 3', `toPar ${s?.toPar}`);

  console.log('\n3. Forged timestamps are clamped (score still stored, at server time)');
  const before = Date.now();
  await api({ deviceToken: token, holeNumber: 2, strokes: 4, enteredAt: '1999-01-01T00:00:00Z' }); // absurd past
  const at2 = await storedAt(reg!.id, 2);
  ok(!!at2 && Date.parse(at2) >= before - 2000, 'a 1999 timestamp was rejected → stored at ~now', at2);

  console.log('\n4. A normal online score still works unchanged (no enteredAt)');
  const r4 = await api({ deviceToken: token, holeNumber: 1, strokes: 4 });
  ok((await r4.json()).scoreStored === true, 'plain submission (no enteredAt) still stores');

  // purge
  for (const tbl of ['score_submissions', 'gps_tracks']) await db.from(tbl).delete().eq('tournament_id', tid);
  await db.from('tournaments').delete().eq('id', tid);
  await db.from('courses').delete().eq('id', course!.id);
  console.log(`\n${failures === 0 ? '✅ OFFLINE SCORE SYNC: correct' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
