// Seeds a realistic LIVE board — a full field with varied real scores, three
// committed sponsors with uploaded logos (so the corner rotates), a paid
// field + sponsor (real "raised"), and a contest hole — then leaves it up so
// the clubhouse TV can be viewed/screenshotted.
//   npx tsx scripts/demo-tv-board.ts run     (prints TV URL, keeps data)
//   npx tsx scripts/demo-tv-board.ts purge
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';
const COURSE = 'ZZZ TV DEMO COURSE — SAFE TO DELETE';
const T_NAME = 'ZZZ TV DEMO — St. Michael\'s Charity Scramble — SAFE TO DELETE';
const PARS = [4, 3, 5, 4, 4, 3, 4, 5, 4]; // front 9, par 36

// company, players, per-hole deltas (9), thru, paid?
const TEAMS = [
  { name: 'Northshore Toyota Eagles', players: ['Reed', 'Petrelli', 'Cho', 'Hinckley'], d: [-1, -1, -1, 0, -1, 0, -1, -1, 0], thru: 9, paid: true },
  { name: 'Lambert & Co. Birdies', players: ['Lambert', 'Faro', 'Bell', 'Knight'], d: [-1, 0, -1, -1, 0, 0, -1, 0, 0], thru: 9, paid: true },
  { name: "St. Michael's Dads", players: ['Curry', 'Ashford', 'Boudreaux', 'Hano'], d: [0, -1, -1, 0, -1, 0, 0, 0, 0], thru: 9, paid: false },
  { name: 'Hinckley Roofing', players: ['Hinckley', 'Day', 'Calloway', 'Pugh'], d: [-1, 0, 0, -1, 0, 0, -1, 0, 0], thru: 8, paid: false },
  { name: 'Riverbend Realty Putters', players: ['Petrelli', 'Carter', 'Lemoine', 'Falgout'], d: [0, 0, -1, 0, -1, 0, 0, 0, 0], thru: 9, paid: false },
  { name: 'Periodontics & Putters', players: ['Cho', 'Vu', 'Tran', 'Boudreaux'], d: [0, 0, 0, -1, 0, 0, 0, 0, 0], thru: 7, paid: false },
  { name: 'Mandeville Mortgage', players: ['Adams', 'Bourg', 'Zito', 'Decuir'], d: [0, 1, 0, 0, -1, 0, 0, 0, 0], thru: 9, paid: false },
];
const logoSvg = (label: string, bg: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="64"><rect width="220" height="64" rx="8" fill="${bg}"/><text x="110" y="41" font-family="Arial" font-size="24" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`;
const SPONSORS = [
  { company: 'Northshore Toyota', status: 'paid', label: 'NORTHSHORE TOYOTA', bg: '#B0132A', amount: 500000 },
  { company: 'Beau Chêne CC', status: 'invoiced', label: 'BEAU CHÊNE', bg: '#0B3D2E', amount: 250000 },
  { company: 'Lambert & Co.', status: 'verbal', label: 'LAMBERT & CO.', bg: '#1D4ED8', amount: 150000 },
];

async function run() {
  console.log(`Seeding a live TV board on ${BASE}\n`);
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const org = anyT?.organizer_id;
  const { data: course } = await db.from('courses').insert({ name: COURSE, city: 'Mandeville', state: 'LA', total_holes: 18, organizer_id: org, profile_status: 'complete' }).select('id').single();
  for (let h = 1; h <= 9; h++) await db.from('course_holes').insert({ course_id: course!.id, hole_number: h, par: PARS[h - 1] });
  const { data: t } = await db.from('tournaments').insert({ organizer_id: org, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: course!.id, format: 'scramble', max_score_rule: 'par', status: 'live' }).select('id').single();
  const tid = t!.id;

  const now = Date.now();
  for (const [i, tm] of TEAMS.entries()) {
    const { data: reg } = await db.from('registrations').insert({
      tournament_id: tid, registration_type: 'foursome', team_name: tm.name, contact_name: tm.players[0],
      contact_email: 'tvdemo@tourneycoach.com', total_amount_cents: 60000, payment_status: tm.paid ? 'paid' : 'pending',
      foursome_number: i + 1, players: tm.players.map((n) => ({ name: n, email: '' })),
    }).select('id').single();
    for (let h = 1; h <= tm.thru; h++) {
      await db.from('score_submissions').insert({
        registration_id: reg!.id, tournament_id: tid, course_id: course!.id, device_id: null,
        hole_number: h, strokes: PARS[h - 1] + tm.d[h - 1], green_labeled_points: 0,
        submitted_at: new Date(now - (tm.thru - h) * 60000).toISOString(),
      });
    }
  }

  // Contest hole (decided) + three sponsors with uploaded logos.
  await db.from('contest_holes').insert({ tournament_id: tid, hole_number: 3, contest_type: 'hole_in_one', prize: 'A new car', winner_name: 'Reed', decided_at: new Date().toISOString() }).then(() => {}, () => {});
  for (const s of SPONSORS) {
    const { data: sp } = await db.from('sponsors').insert({ tournament_id: tid, company: s.company, amount_cents: s.amount, status: s.status, source: 'organizer' }).select('id').single();
    const path = `${tid}/${sp!.id}-logo.svg`;
    await db.storage.from('sponsor-logos').upload(path, Buffer.from(logoSvg(s.label, s.bg)), { contentType: 'image/svg+xml', upsert: true });
    const { data: pub } = db.storage.from('sponsor-logos').getPublicUrl(path);
    await db.from('sponsors').update({ logo_url: pub.publicUrl, logo_received: true }).eq('id', sp!.id);
  }

  const board = await (await fetch(`${BASE}/api/tournament/${tid}/board`, { cache: 'no-store' } as RequestInit)).json();
  console.log('Leaderboard:');
  for (const s of board.standings) console.log(`  ${s.tied ? 'T-' : ''}${s.rank}  ${(s.teamName + '                     ').slice(0, 26)} ${s.holesCompleted === 9 ? 'F' : 'thru ' + s.holesCompleted}  ${s.toPar === 0 ? 'E' : s.toPar > 0 ? '+' + s.toPar : s.toPar}`);
  console.log(`  Sponsors rotating: ${board.sponsors.map((x: { company: string }) => x.company).join(', ')}`);
  console.log(`  Raised: $${(board.raisedCents / 100).toLocaleString()}`);
  console.log(`\n  ► TV board:  ${BASE}/tv/${tid}\n`);
}

async function purge() {
  const { data: ts } = await db.from('tournaments').select('id').eq('name', T_NAME);
  for (const t of ts ?? []) {
    const { data: files } = await db.storage.from('sponsor-logos').list(t.id);
    if (files?.length) await db.storage.from('sponsor-logos').remove(files.map((f) => `${t.id}/${f.name}`));
    for (const tbl of ['score_submissions', 'sponsors', 'contest_holes', 'gps_tracks']) await db.from(tbl).delete().eq('tournament_id', t.id);
    await db.from('tournaments').delete().eq('id', t.id);
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE);
  for (const c of cs ?? []) await db.from('courses').delete().eq('id', c.id);
  const { data: left } = await db.from('tournaments').select('id').eq('name', T_NAME);
  console.log(`Purged. Remaining: ${left?.length ?? 0}`);
}

const mode = process.argv[2];
if (mode === 'run') run(); else if (mode === 'purge') purge(); else { console.log('usage: run|purge'); process.exit(1); }
