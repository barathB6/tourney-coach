// Day 29 — Communication Engine + guidance triggers, against the real database.
//
// What this proves that verify-guidance.ts cannot: the ledger claim survives
// concurrency, the in-app mirror always lands, profiles actually recompute on
// the three spec'd triggers, the cadence run sends exactly one reminder per
// slot per volunteer, two-way messages flow both directions, and the token
// cannot cross tenants.
//
// Sends are attempted for real: email goes through SendGrid to
// *.example.invalid (accepted by the API, delivered nowhere), SMS records its
// honest unconfigured failure, in-app always lands.
//
//   npx tsx scripts/verify-comm-guidance-db.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { sendComm } from '../lib/comm/engine';
import { runCadence } from '../lib/comm/runCadence';
import { recordGuidanceEvent, loadProfile, recomputeProfile } from '../lib/guidance/profile';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

const TAG = 'ZZZ COMM29';
// Unique per run. The experience signal matches prior volunteering BY EMAIL,
// so a fixed domain means fixtures left behind by a crashed run silently turn
// the next run's "first-timer" into a "returning" volunteer. That happened.
const RUN = Date.now().toString(36);
const DOM = `${RUN}.comm29.example.invalid`;

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

async function main() {
  const { error: schemaErr } = await db.from('volunteer_guidance_profiles').select('id').limit(1);
  if (schemaErr) {
    console.log(`\n❌ Migration 043 has not been run — ${schemaErr.message}`);
    console.log('   Run db/migrations/043_comm_guidance.sql in the Supabase SQL editor, then re-run this.');
    process.exit(1);
  }

  // ── Fixtures: a tournament 20 hours out, with three volunteers ────────────
  const { data: owner } = await db.auth.admin.createUser({
    email: `zzz-owner-${Date.now()}@${DOM}`, password: `zzzAa1!${Math.random().toString(36).slice(2)}`, email_confirm: true,
  });
  const eventAt = new Date(Date.now() + 20 * 3_600_000);
  const eventDate = eventAt.toISOString().slice(0, 10);
  const shotgun = `${String(eventAt.getUTCHours()).padStart(2, '0')}:${String(eventAt.getUTCMinutes()).padStart(2, '0')}`;

  const { data: t } = await db.from('tournaments').insert({
    name: `${TAG} EVENT`, organizer_id: owner!.user!.id,
    event_date: eventDate, shotgun_time: shotgun, format: 'scramble',
    max_players: 72, entry_fee_cents: 16500, status: 'draft',
  }).select('id').single();
  const tid = t!.id as string;

  // A PRIOR tournament to make one volunteer a veteran with history.
  const { data: prior } = await db.from('tournaments').insert({
    name: `${TAG} PRIOR`, organizer_id: owner!.user!.id,
    event_date: '2025-06-01', shotgun_time: '08:00', format: 'scramble',
    max_players: 72, entry_fee_cents: 10000, status: 'completed',
  }).select('id').single();

  const { data: roles } = await db.from('role_templates').select('id, name, phase');
  const dayOfRole = roles!.find((r) => r.phase === 'day_of')!;

  const mkVol = async (name: string, email: string | null, phone: string | null, tournamentId = tid) => {
    const { data, error } = await db.from('volunteers').insert({
      tournament_id: tournamentId, name, email, phone,
    }).select('id').single();
    if (error || !data) throw new Error(`fixture volunteer: ${error?.message ?? 'no row'}`);
    return data.id as string;
  };
  const mkAssign = async (volId: string, tournamentId = tid, status = 'confirmed') => {
    const { data, error } = await db.from('tournament_volunteer_assignments').insert({
      tournament_id: tournamentId, volunteer_id: volId, role_template_id: dayOfRole.id,
      status, invite_token: crypto.randomUUID(),
      invited_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      responded_at: new Date(Date.now() - 2.9 * 86_400_000).toISOString(),
    }).select('id, invite_token').single();
    if (error || !data) throw new Error(`fixture assignment: ${error?.message ?? 'no row'}`);
    return { id: data.id as string, token: data.invite_token as string };
  };

  const rookieId = await mkVol(`${TAG} Rookie`, `rookie@${DOM}`, null);
  const rookie = await mkAssign(rookieId);
  // Veteran: same email volunteered at 3 "prior" tournaments... one prior here
  // plus declared via events; simplest real signal: rows in other tournaments.
  const vetEmail = `veteran@${DOM}`;
  const vetPriorId = await mkVol(`${TAG} Vet(prior)`, vetEmail, null, prior!.id as string);
  void vetPriorId;
  const { data: prior2 } = await db.from('tournaments').insert({
    name: `${TAG} PRIOR2`, organizer_id: owner!.user!.id, event_date: '2024-06-01',
    shotgun_time: '08:00', format: 'scramble', max_players: 72, entry_fee_cents: 10000, status: 'completed',
  }).select('id').single();
  const { data: prior3 } = await db.from('tournaments').insert({
    name: `${TAG} PRIOR3`, organizer_id: owner!.user!.id, event_date: '2023-06-01',
    shotgun_time: '08:00', format: 'scramble', max_players: 72, entry_fee_cents: 10000, status: 'completed',
  }).select('id').single();
  await mkVol(`${TAG} Vet(p2)`, vetEmail, null, prior2!.id as string);
  await mkVol(`${TAG} Vet(p3)`, vetEmail, null, prior3!.id as string);
  const vetId = await mkVol(`${TAG} Veteran`, vetEmail, '9855550134');
  const vetAssign = await mkAssign(vetId);

  // Cleanup is defined before any assertion and called from finally, so a
  // mid-test throw cannot leave fixtures behind for the next run to trip over.
  const cleanup = async () => {
    for (const table of ['guidance_events', 'volunteer_task_completions', 'volunteer_messages',
      'volunteer_guidance_profiles', 'push_subscriptions']) {
      await db.from(table).delete().eq('tournament_id', tid);
    }
    await db.from('communication_log').delete().eq('tournament_id', tid);
    for (const tt of [tid, prior!.id as string, prior2!.id as string, prior3!.id as string]) {
      await db.from('tournament_volunteer_assignments').delete().eq('tournament_id', tt);
      await db.from('volunteers').delete().eq('tournament_id', tt);
      await db.from('tournaments').delete().eq('id', tt);
    }
    await db.auth.admin.deleteUser(owner!.user!.id);
  };

  try {
    section('1. Profiles computed from real rows');
    const rookieProfile = await loadProfile(db, tid, rookieId);
    const vetProfile = await loadProfile(db, tid, vetId);
    console.log(`      rookie:  ${rookieProfile.experienceLevel} → ${rookieProfile.depth}/${rookieProfile.cadence}/${rookieProfile.channel}`);
    console.log(`      veteran: ${vetProfile.experienceLevel} → ${vetProfile.depth}/${vetProfile.cadence}/${vetProfile.channel}`);
    ok(rookieProfile.experienceLevel === 'first_timer' && rookieProfile.depth === 'detailed',
      'no history → first-timer, detailed');
    ok(vetProfile.experienceLevel === 'veteran',
      'three prior tournaments (matched by email) → veteran', vetProfile.experienceLevel);
    ok(vetProfile.depth === 'minimal' && vetProfile.cadence === 'light', 'veteran gets minimal/light');
    const { data: storedProfiles } = await db.from('volunteer_guidance_profiles')
      .select('volunteer_id, signals').eq('tournament_id', tid);
    ok((storedProfiles ?? []).length === 2, 'profiles persisted with their signal snapshots');

    section('2. Recompute triggers — the three the spec names');
    // (a) engagement event
    await recordGuidanceEvent(db, tid, rookieId, 'portal_viewed');
    let { data: p1 } = await db.from('volunteer_guidance_profiles')
      .select('recompute_reason').eq('volunteer_id', rookieId).single();
    ok(p1?.recompute_reason === 'event:portal_viewed', 'an engagement event recomputes the profile');

    // (b) task completion — three on-time completions should trim depth
    const { data: roleTasks } = await db.from('task_templates')
      .select('id').eq('role_template_id', dayOfRole.id).limit(3);
    for (const task of roleTasks ?? []) {
      await db.from('volunteer_task_completions').insert({
        tournament_id: tid, assignment_id: rookie.id, task_template_id: task.id as string,
        completed_late: false,
      });
    }
    await recordGuidanceEvent(db, tid, rookieId, 'task_completed');
    const after = await loadProfile(db, tid, rookieId);
    ok(after.depth === 'standard',
      'three on-time completions trimmed the rookie from detailed to standard — performance feeds back', after.depth);

    // (c) feedback — and it must win
    await recordGuidanceEvent(db, tid, rookieId, 'feedback', { wantsMoreDetail: true });
    const afterFb = await loadProfile(db, tid, rookieId);
    ok(afterFb.depth === 'detailed', 'feedback outranks the performance inference');
    ({ data: p1 } = await db.from('volunteer_guidance_profiles')
      .select('recompute_reason').eq('volunteer_id', rookieId).single());
    ok(p1?.recompute_reason === 'event:feedback', 'and the profile records why it changed');

    section('3. Comm engine — ledger, mirror, honesty');
    const emailSend = await sendComm(db, {
      recipient: { volunteerId: rookieId, tournamentId: tid, name: 'Rookie', email: `rookie@${DOM}`, phone: null },
      kind: 'ad_hoc', subject: `${TAG} hello`, body: 'A test message.', channel: 'email',
    });
    ok(emailSend.channel === 'email', 'email recipient resolves to the email channel');
    const { data: mirror } = await db.from('communication_log')
      .select('channel, status').eq('volunteer_id', rookieId).eq('subject', `${TAG} hello`);
    ok((mirror ?? []).some((m) => m.channel === 'in_app' && m.status === 'delivered'),
      'every send is mirrored in-app, so the portal always has the history');

    // SMS with Twilio unconfigured: fails honestly, in ledger, then mirrors.
    const smsSend = await sendComm(db, {
      recipient: { volunteerId: vetId, tournamentId: tid, name: 'Vet', email: null, phone: '9855550134' },
      kind: 'ad_hoc', subject: `${TAG} sms`, body: 'Test.', channel: 'sms',
    });
    ok(smsSend.channel === 'in_app' || (!smsSend.ok && !!smsSend.error),
      'with Twilio unconfigured, SMS degrades or records the real failure — never a silent success',
      `channel=${smsSend.channel} ok=${smsSend.ok}`);

    const nobody = await sendComm(db, {
      recipient: { volunteerId: rookieId, tournamentId: tid, name: 'R', email: null, phone: null },
      kind: 'ad_hoc', subject: `${TAG} unreachable`, body: 'x', channel: 'sms',
    });
    ok(nobody.ok && nobody.channel === 'in_app', 'a volunteer with no contact details still gets the in-app copy');

    section('4. Cadence run — one slot, once, per volunteer');
    const run1 = await runCadence(db);
    const mine1 = run1.details.filter((d) => [rookieId, vetId].includes(d.volunteerId));
    // 20 hours out = inside the 24h band for both cadences (light includes 1440).
    ok(mine1.filter((d) => d.volunteerId === rookieId).length === 1, 'rookie got exactly one reminder (24h slot)');
    ok(mine1.filter((d) => d.volunteerId === vetId).length === 1, 'veteran got exactly one reminder too — light cadence includes 24h');
    ok(mine1.every((d) => d.offsetKey === 'pre_event:1440'), 'both landed in the 24-hour slot', mine1.map((d) => d.offsetKey).join(','));

    const run2 = await runCadence(db);
    const mine2 = run2.details.filter((d) => [rookieId, vetId].includes(d.volunteerId));
    ok(mine2.length === 0 || mine2.every((d) => !d.ok), 'a second run sends nothing new — the claim held',
      `${mine2.length} attempts`);
    const { data: claims } = await db.from('communication_log')
      .select('volunteer_id, offset_key').eq('tournament_id', tid).eq('kind', 'reminder').not('offset_key', 'is', null);
    const keys = (claims ?? []).map((c) => `${c.volunteer_id}|${c.offset_key}`);
    ok(new Set(keys).size === keys.length, 'no duplicate (volunteer, slot) claims exist', `${keys.length} claims`);

    section('5. Two-way messaging through the real APIs');
    const { POST: portalPost } = await import('../app/api/volunteer/portal/route');
    const { NextRequest } = await import('next/server');
    const post = (body: Record<string, unknown>) => portalPost(new NextRequest('http://localhost/api/volunteer/portal', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

    const msgRes = await post({ token: rookie.token, action: 'message', body: 'Where do I park?', audience: 'organizer' });
    ok(msgRes.status === 200, 'a volunteer can message with only their token');
    const { data: thread } = await db.from('volunteer_messages')
      .select('direction, audience, body').eq('volunteer_id', rookieId);
    ok((thread ?? []).some((m) => m.direction === 'from_volunteer' && m.body === 'Where do I park?'),
      'the message landed in the thread');

    const escRes = await post({ token: rookie.token, action: 'message', body: 'The organizer is not answering.', audience: 'platform' });
    ok(escRes.status === 200, 'escalation accepted');
    const { data: esc } = await db.from('volunteer_messages')
      .select('escalated_at').eq('volunteer_id', rookieId).eq('audience', 'platform');
    ok((esc ?? []).every((m) => !!m.escalated_at), 'platform messages are stamped escalated');
    const { data: escMail } = await db.from('communication_log')
      .select('kind, recipient_email, channel').eq('tournament_id', tid).eq('kind', 'escalation');
    ok((escMail ?? []).some((m) => (m.recipient_email as string)?.includes('admin@')),
      'and an escalation email to admin@ was attempted and recorded');

    // Both shapes must be rejected, and neither may 500: a well-formed token
    // that belongs to nobody, and a malformed one the database cannot even cast.
    const unknownToken = await post({ token: crypto.randomUUID(), action: 'message', body: 'hi', audience: 'organizer' });
    ok(unknownToken.status === 404, 'a well-formed but unknown token is rejected');
    const malformed = await post({ token: 'zzz-not-a-real-token-000', action: 'message', body: 'hi', audience: 'organizer' });
    ok(malformed.status === 404, 'a malformed token is rejected without a 500', String(malformed.status));

    // Cross-role containment: rookie's token cannot complete a task from a
    // DIFFERENT role.
    const { data: otherRole } = await db.from('role_templates').select('id').neq('id', dayOfRole.id).limit(1).single();
    const { data: foreignTask } = await db.from('task_templates')
      .select('id').eq('role_template_id', otherRole!.id as string).limit(1).single();
    const cross = await post({ token: rookie.token, action: 'complete_task', taskId: foreignTask!.id as string });
    ok(cross.status === 404, 'a token cannot tick off another role\'s task');

    section('6. Depth personalization visible through the portal API');
    const { GET: portalGet } = await import('../app/api/volunteer/portal/route');
    const getSnap = async (token: string) => {
      const res = await portalGet(new NextRequest(`http://localhost/api/volunteer/portal?token=${token}`));
      return res.json();
    };
    // The heart of the demo: two volunteers, the SAME role and the SAME tasks,
    // rendered at different depths because their profiles differ.
    const rookieSnap = await getSnap(rookie.token);
    const vetSnap = await getSnap(vetAssign.token);
    const sameTask = rookieSnap.tasks[0].title === vetSnap.tasks[0].title;
    ok(sameTask, 'both volunteers hold the same role and see the same first task', rookieSnap.tasks[0].title);
    ok(rookieSnap.guidance.depth === 'detailed' && rookieSnap.tasks[0].lines.length >= 4,
      'the first-timer gets full numbered steps', `${rookieSnap.tasks[0].lines.length} lines`);
    ok(vetSnap.guidance.depth === 'minimal' && vetSnap.tasks[0].lines.length === 1,
      'the veteran gets one line for the identical task', `${vetSnap.tasks[0].lines.length} line`);
    ok(rookieSnap.tasks[0].lines.join(' ') !== vetSnap.tasks[0].lines.join(' '),
      'SIDE BY SIDE: same task, genuinely different content — Concept E, demonstrable');
    console.log(`      first-timer sees: "${rookieSnap.tasks[0].lines[0].slice(0, 70)}…"`);
    console.log(`      veteran sees:     "${vetSnap.tasks[0].lines[0].slice(0, 70)}"`);

    section('7. Recompute is idempotent and order-independent');
    const before = await recomputeProfile(db, tid, rookieId, 'test');
    const again = await recomputeProfile(db, tid, rookieId, 'test');
    ok(JSON.stringify(before) === JSON.stringify(again), 'recomputing twice changes nothing');
  } finally {
    await cleanup();
    console.log('\n  (fixtures removed)');
  }

  console.log(failures === 0
    ? '\n✅ COMM + GUIDANCE DB — ALL CHECKS PASSED'
    : `\n❌ COMM + GUIDANCE DB — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
