// A logical backup of one tournament's whole configuration and state.
//
// Supabase's own automated backups (daily on the paid plan, PITR on Pro+) are
// the real disaster-recovery story — this is not a replacement for them. It is
// the cheap, human-readable safety net for the case that actually happens to a
// beta: someone fat-fingers an edit, a bad script deletes the wrong rows, a
// status flips by accident. One JSON file you can diff and, if need be, restore
// from without a point-in-time recovery.
//
//   npx tsx scripts/snapshot-tournament.ts <slug-or-id>            # write snapshot
//   npx tsx scripts/snapshot-tournament.ts <slug-or-id> --verify   # compare live vs newest snapshot
//
// Snapshots are written to db/snapshots/<slug>-<timestamp>.json.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL')!, get('SUPABASE_SERVICE_ROLE_KEY')!);

// Every table that carries a tournament's config or state, keyed by tournament_id.
const CHILD_TABLES = [
  'tournament_goals', 'sponsorship_tiers', 'sponsors', 'registrations',
  'volunteers', 'tournament_volunteer_assignments', 'planning_meetings',
  'meeting_action_items', 'meeting_attendance', 'donation_prospects',
  'donation_outreach_log', 'fb_calculations', 'contest_holes', 'contest_entries',
  'tournament_goals', 'communication_log', 'tournament_events', 'score_submissions',
  'score_corrections',
];

async function loadTournament(idOrSlug: string) {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const { data } = await db.from('tournaments').select('*')
    .eq(byId ? 'id' : 'slug', idOrSlug).maybeSingle();
  return data;
}

async function snapshot(idOrSlug: string, stamp: string) {
  const t = await loadTournament(idOrSlug);
  if (!t) { console.error(`No tournament matches "${idOrSlug}".`); process.exit(1); }
  const tid = t.id as string;

  const children: Record<string, unknown[]> = {};
  let rows = 0;
  for (const table of [...new Set(CHILD_TABLES)]) {
    const { data, error } = await db.from(table).select('*').eq('tournament_id', tid);
    if (error) { children[table] = [{ __error: error.message }]; continue; }
    children[table] = data ?? [];
    rows += (data ?? []).length;
  }
  // The course is referenced, not owned — capture it so a restore has the venue.
  const { data: course } = t.course_id
    ? await db.from('courses').select('*').eq('id', t.course_id).maybeSingle()
    : { data: null };

  const snap = {
    capturedAt: stamp,
    tournament: t,
    course,
    children,
    summary: { childRows: rows, tables: Object.keys(children).length },
  };

  mkdirSync(new URL('../db/snapshots/', import.meta.url), { recursive: true });
  const file = new URL(`../db/snapshots/${t.slug ?? tid}-${stamp.replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`✅ Snapshot of "${t.name}" — ${rows} child row(s) across ${Object.keys(children).length} tables`);
  console.log(`   ${file.pathname}`);
  return snap;
}

async function verify(idOrSlug: string) {
  // Compare the live tournament row against the newest snapshot on disk — a
  // fast "did the config drift?" check to run right before the event.
  const dir = new URL('../db/snapshots/', import.meta.url);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  const t = await loadTournament(idOrSlug);
  if (!t) { console.error('No such tournament.'); process.exit(1); }
  const mine = files.filter((f) => f.startsWith(`${t.slug}-`)).sort();
  if (!mine.length) { console.log('No snapshot on disk yet — run without --verify first.'); return; }
  const newest = JSON.parse(readFileSync(new URL(mine[mine.length - 1], dir), 'utf8'));
  const before = newest.tournament, after = t;
  const drift: string[] = [];
  for (const k of ['status', 'event_date', 'shotgun_time', 'entry_fee_cents', 'max_players', 'slug', 'fundraising_goal_cents']) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) drift.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
  }
  console.log(`Newest snapshot: ${mine[mine.length - 1]}`);
  console.log(drift.length ? `⚠️  CONFIG DRIFT since snapshot:\n  ${drift.join('\n  ')}` : '✅ No drift in core config since the last snapshot.');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('Usage: snapshot-tournament.ts <slug-or-id> [--verify]'); process.exit(1); }
  if (process.argv.includes('--verify')) return verify(arg);
  // Deterministic timestamp from the environment, since new Date() is fine here
  // (this is a CLI, not a workflow).
  await snapshot(arg, new Date().toISOString());
}

main().catch((e) => { console.error(e); process.exit(1); });
