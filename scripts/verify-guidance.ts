// Day 29 — Personalized Guidance Engine (patent Concept E) verification.
//
// The engine's promise is that it is DETERMINISTIC and EXPLAINABLE: five
// signals in, one profile out, same answer every time, with reasons. So the
// tests here are the spec's own scenarios run side by side — a first-timer, a
// returning volunteer and a veteran fed identical circumstances — plus the
// precedence rules that must never invert (feedback beats inference, safety
// beats convenience).
//
// Pure model + content library; no database writes. The DB-side triggers are
// covered by verify-comm-guidance-db.ts.
//
//   npx tsx scripts/verify-guidance.ts
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  computeGuidance, experienceLevelFrom, usableChannel,
  type GuidanceSignals,
} from '../lib/guidance/engine';
import { CADENCE_SETS, PRE_EVENT_OFFSETS, dueOffsets, reminderBody, DAY_OF_TRIGGERS } from '../lib/comm/cadence';
import { CONTENT_LIBRARY } from '../lib/guidance/contentLibrary';
import { contentFor, contentKey, linesAtDepth, deriveContent } from '../lib/guidance/content';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

let failures = 0;
const ok = (cond: boolean, msg: string, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const section = (n: string) => console.log(`\n${n}`);

// A neutral, engaged, phone-owning volunteer — the baseline everyone varies from.
const base = (over: Partial<GuidanceSignals> = {}): GuidanceSignals => ({
  role: { phase: 'day_of', roleName: 'Registration Lead' },
  experience: { priorTournaments: 0, declaredLevel: null },
  state: { daysToEvent: 14, isEventDay: false },
  engagement: { portalViews: 1, responseLatencyHours: 20, messagesSent: 0, unopenedEmails: 0, hasPhone: true, hasPushSubscription: false },
  performance: { tasksCompleted: 0, tasksCompletedLate: 0, priorNoShows: 0 },
  feedback: {},
  ...over,
});

async function main() {
  // ── The spec's side-by-side: first-timer / returning / veteran ────────────
  section('1. Side-by-side — identical circumstances, three experience levels');
  const firstTimer = computeGuidance(base({ experience: { priorTournaments: 0, declaredLevel: null } }));
  const returning = computeGuidance(base({ experience: { priorTournaments: 1, declaredLevel: null } }));
  const veteran = computeGuidance(base({ experience: { priorTournaments: 4, declaredLevel: null } }));

  console.log(`      first-timer: ${firstTimer.depth} / ${firstTimer.cadence} / ${firstTimer.channel}`);
  console.log(`      returning:   ${returning.depth} / ${returning.cadence} / ${returning.channel}`);
  console.log(`      veteran:     ${veteran.depth} / ${veteran.cadence} / ${veteran.channel}`);

  ok(firstTimer.depth === 'detailed' && firstTimer.cadence === 'full',
    'a first-timer gets full detail and every reminder');
  ok(returning.depth === 'standard' && returning.cadence === 'standard',
    'a returning volunteer gets the middle of both');
  ok(veteran.depth === 'minimal' && veteran.cadence === 'light',
    'a veteran gets reminders, not a manual');
  ok(firstTimer.depth !== veteran.depth && firstTimer.cadence !== veteran.cadence,
    'the two ends of the spectrum are genuinely different — this is the demonstrable mechanism');
  ok([firstTimer, returning, veteran].every((p) => p.reasons.length >= 3),
    'every profile explains itself', `${firstTimer.reasons.length}/${returning.reasons.length}/${veteran.reasons.length} reasons`);

  section('2. Experience level boundaries');
  ok(experienceLevelFrom({ priorTournaments: 0 }) === 'first_timer', '0 prior → first-timer');
  ok(experienceLevelFrom({ priorTournaments: 1 }) === 'returning', '1 prior → returning');
  ok(experienceLevelFrom({ priorTournaments: 2 }) === 'returning', '2 prior → still returning');
  ok(experienceLevelFrom({ priorTournaments: 3 }) === 'veteran', '3 prior → veteran');
  ok(experienceLevelFrom({ priorTournaments: -5 }) === 'first_timer', 'a negative count clamps to first-timer');
  ok(experienceLevelFrom({ priorTournaments: 0, declaredLevel: 'veteran' }) === 'veteran',
    'an explicit declaration overrides the count');

  section('3. Precedence — the rules that must never invert');
  const askedForDetail = computeGuidance(base({
    experience: { priorTournaments: 5, declaredLevel: null },
    feedback: { wantsMoreDetail: true },
  }));
  ok(askedForDetail.depth === 'detailed',
    'a veteran who ASKED for detail gets detail — feedback beats inference');

  const askedForLess = computeGuidance(base({ feedback: { wantsLessDetail: true } }));
  ok(askedForLess.depth === 'minimal', 'a first-timer who asked for less gets less');

  const noShowVeteran = computeGuidance(base({
    experience: { priorTournaments: 5, declaredLevel: null },
    performance: { tasksCompleted: 0, tasksCompletedLate: 0, priorNoShows: 1 },
  }));
  ok(noShowVeteran.cadence === 'full',
    'a prior no-show forces the full cadence regardless of experience — safety beats convenience');
  ok(noShowVeteran.depth !== 'minimal',
    'and bumps their instruction depth up too');

  const struggling = computeGuidance(base({
    experience: { priorTournaments: 1, declaredLevel: null },
    performance: { tasksCompleted: 4, tasksCompletedLate: 2, priorNoShows: 0 },
  }));
  ok(struggling.depth === 'detailed', 'two late tasks push a returning volunteer back to detailed');

  const cruising = computeGuidance(base({
    performance: { tasksCompleted: 4, tasksCompletedLate: 0, priorNoShows: 0 },
  }));
  ok(cruising.depth === 'standard', 'four on-time completions trim a first-timer to standard');

  const ghost = computeGuidance(base({
    experience: { priorTournaments: 2, declaredLevel: null },
    engagement: { portalViews: 0, responseLatencyHours: null, messagesSent: 0, unopenedEmails: 0, hasPhone: false, hasPushSubscription: false },
  }));
  ok(ghost.depth === 'detailed', 'someone never reached gets the fullest version when we finally reach them');

  section('4. Channel selection');
  const eventDay = computeGuidance(base({ state: { daysToEvent: 0, isEventDay: true } }));
  ok(eventDay.channel === 'sms', 'event day with a phone → SMS, nobody reads email at the check-in table');

  const pushUser = computeGuidance(base({
    engagement: { ...base().engagement, hasPushSubscription: true },
    role: { phase: 'planning', roleName: 'Goal Tracker' }, state: { daysToEvent: 30, isEventDay: false },
  }));
  ok(pushUser.channel === 'push', 'a push subscription wins outside event day');

  const ignoresEmail = computeGuidance(base({
    role: { phase: 'planning', roleName: 'Goal Tracker' },
    state: { daysToEvent: 30, isEventDay: false },
    engagement: { ...base().engagement, unopenedEmails: 3 },
  }));
  ok(ignoresEmail.channel === 'sms', 'two-plus unopened emails and a phone → switch to SMS');

  const picked = computeGuidance(base({ state: { daysToEvent: 0, isEventDay: true }, feedback: { preferredChannel: 'email' } }));
  ok(picked.channel === 'email', 'an explicitly chosen channel wins even on event day');

  ok(usableChannel('sms', { phone: false, email: true, push: false }) === 'email',
    'preferred SMS with no phone degrades to email');
  ok(usableChannel('push', { phone: false, email: false, push: false }) === 'in_app',
    'nothing reachable degrades to in-app, which cannot fail');

  section('5. Determinism');
  const a = computeGuidance(base());
  const b = computeGuidance(base());
  ok(JSON.stringify(a) === JSON.stringify(b), 'same signals twice → byte-identical profile, reasons included');

  // ── Cadence library ────────────────────────────────────────────────────────
  section('6. Cadence sets and bands');
  ok(PRE_EVENT_OFFSETS.map((o) => o.minutes).join(',') === '10080,2880,1440,360,30',
    'the five spec slots: 7d, 48h, 24h, 6h, 30m');
  ok(CADENCE_SETS.full.length === 5 && CADENCE_SETS.standard.length === 3 && CADENCE_SETS.light.length === 2,
    'full=5, standard=3, light=2 slots');
  ok(Object.values(CADENCE_SETS).every((set) => set.includes(30)),
    'no intensity opts out of the 30-minute reminder');

  // Exactly one slot due at any minute, for every cadence.
  for (const cadence of ['full', 'standard', 'light'] as const) {
    let maxDue = 0;
    let covered = 0;
    for (let m = 0; m <= 11_000; m += 7) {
      const due = dueOffsets(m, cadence, new Set());
      maxDue = Math.max(maxDue, due.length);
      if (due.length) covered++;
    }
    ok(maxDue === 1, `${cadence}: never more than one slot due at once`);
    ok(covered > 0, `${cadence}: the ladder actually fires somewhere`);
  }
  ok(dueOffsets(29, 'full', new Set()).length === 1 && dueOffsets(29, 'full', new Set())[0].minutes === 30,
    '29 minutes out is inside the 30-minute band');
  ok(dueOffsets(31, 'full', new Set())[0]?.minutes === 360,
    '31 minutes out belongs to the 6-hour band — bands partition, they do not overlap');
  ok(dueOffsets(31, 'light', new Set())[0]?.minutes === 1440,
    'for light cadence the band floor moves: 31 minutes out is inside the 24h slot band');
  ok(dueOffsets(500, 'full', new Set(['pre_event:1440'])).length === 0,
    'an already-claimed slot is never re-sent');
  ok(dueOffsets(-10, 'full', new Set()).length === 0, 'a started role gets nothing');
  ok(dueOffsets(Number.NaN, 'full', new Set()).length === 0, 'NaN minutes gets nothing');

  const body = reminderBody({
    volunteerName: 'Dana Whitfield', roleName: 'Registration Lead', tournamentName: 'St. Michael’s Cup',
    startsAtLabel: 'Saturday at 6:30 AM', offset: PRE_EVENT_OFFSETS[4], portalUrl: 'https://x/v/abc',
  });
  ok(body.body.includes('Saturday at 6:30 AM') && !body.body.includes('30 minutes'),
    'reminder copy names the actual time, never a relative phrase that goes stale');
  ok(DAY_OF_TRIGGERS.length === 3 && DAY_OF_TRIGGERS.every((t) => t.key.startsWith('day_of:')),
    'day-of triggers are event-keyed, not clock-keyed');

  // ── Content library ────────────────────────────────────────────────────────
  section('7. Content library — coverage against the real task templates');
  const { data: roles } = await db.from('role_templates').select('id, name');
  const { data: tasks } = await db.from('task_templates').select('role_template_id, title');
  const roleName = new Map((roles ?? []).map((r) => [r.id as string, r.name as string]));
  const missing: string[] = [];
  for (const t of tasks ?? []) {
    const rn = roleName.get(t.role_template_id as string) ?? '';
    if (!CONTENT_LIBRARY[contentKey(rn, t.title as string)]) missing.push(`${rn}|${t.title}`);
  }
  ok((tasks ?? []).length >= 71, `all ${tasks?.length} seeded templates present in the database`);
  ok(missing.length === 0, 'every task template has authored content at all three depths', missing.slice(0, 3).join('; '));

  let contractBad = 0;
  for (const [, e] of Object.entries(CONTENT_LIBRARY)) {
    if (e.detailed.length < 4 || e.detailed.length > 6) contractBad++;
    if (e.standard.length < 2 || e.standard.length > 3) contractBad++;
    if (e.minimal.length === 0 || e.minimal.length > 90) contractBad++;
  }
  ok(contractBad === 0, 'every entry honours the depth contract (4-6 / 2-3 / ≤90 chars)', `${contractBad} violations`);

  // The three depths must be genuinely different, not truncations.
  let identical = 0;
  for (const [, e] of Object.entries(CONTENT_LIBRARY)) {
    if (e.detailed.join('|') === e.standard.join('|')) identical++;
    if (e.standard[0] === e.minimal) identical++;
  }
  ok(identical === 0, 'no depth is a copy of another depth', `${identical} copies`);

  const sample = contentFor('Registration Lead', 'Reconcile the cash box', null);
  ok(sample.authored, 'a seeded task resolves to authored content');
  ok(linesAtDepth(sample, 'minimal').length === 1 && linesAtDepth(sample, 'detailed').length >= 4,
    'depth selection returns the right shape');

  const custom = contentFor('Registration Lead', 'A task the organizer just invented', 'Do the thing. Then check it.');
  ok(!custom.authored && custom.detailed.length >= 3 && custom.minimal.length <= 90,
    'a never-seen task falls through to derivation and still renders at every depth');
  const empty = deriveContent('X', null);
  ok(empty.detailed.length >= 2 && empty.standard.length >= 1, 'derivation survives a null description');

  console.log(failures === 0
    ? '\n✅ GUIDANCE ENGINE — ALL CHECKS PASSED'
    : `\n❌ GUIDANCE ENGINE — ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
