// Verifies UPLOADED sponsor logos actually surface + rotate on the clubhouse
// TV. Uploads real files to the public sponsor-logos storage bucket (like the
// upload route does), across the three committed statuses (paid/invoiced/
// verbal), then checks the board returns all of them with working public URLs.
//   npx tsx scripts/e2e-sponsor-logos.ts run     (seeds, prints TV URL, keeps data)
//   npx tsx scripts/e2e-sponsor-logos.ts purge
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()!;
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';
const COURSE = 'ZZZ SPONSOR COURSE — SAFE TO DELETE';
const T_NAME = 'ZZZ SPONSOR LOGO TEST — SAFE TO DELETE';

const logoSvg = (label: string, bg: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="64"><rect width="200" height="64" rx="8" fill="${bg}"/><text x="100" y="40" font-family="Arial" font-size="26" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`;
const SPONSORS = [
  { company: 'ACME Roofing', status: 'paid', label: 'ACME', bg: '#B45309', amount: 250000 },
  { company: 'Orca Financial', status: 'invoiced', label: 'ORCA', bg: '#1D4ED8', amount: 150000 },
  { company: 'Peak Outfitters', status: 'verbal', label: 'PEAK', bg: '#047857', amount: 100000 },
];

let failures = 0;
const ok = (c: boolean, m: string, d = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${m}${d ? ` — ${d}` : ''}`); if (!c) failures++; };

async function run() {
  console.log(`Sponsor-logo rotation test against ${BASE}\n`);
  const { data: anyT } = await db.from('tournaments').select('organizer_id').not('organizer_id', 'is', null).limit(1).maybeSingle();
  const { data: course } = await db.from('courses').insert({ name: COURSE, city: 'Testville', state: 'CA', total_holes: 18, organizer_id: anyT?.organizer_id, profile_status: 'complete' }).select('id').single();
  const { data: t } = await db.from('tournaments').insert({ organizer_id: anyT?.organizer_id, name: T_NAME, event_date: new Date().toISOString().slice(0, 10), course_id: course!.id, format: 'scramble', status: 'live' }).select('id').single();
  const tid = t!.id;

  console.log('1. Create 3 committed sponsors + UPLOAD a real logo for each');
  for (const s of SPONSORS) {
    const { data: sp } = await db.from('sponsors').insert({ tournament_id: tid, company: s.company, amount_cents: s.amount, status: s.status, source: 'organizer' }).select('id').single();
    // Upload to the public bucket exactly like app/api/sponsors/[id]/logo does:
    // path = <tournament_id>/<sponsor_id>-<filename>
    const path = `${tid}/${sp!.id}-logo.svg`;
    const { error: upErr } = await db.storage.from('sponsor-logos').upload(path, Buffer.from(logoSvg(s.label, s.bg)), { contentType: 'image/svg+xml', upsert: true });
    if (upErr) { ok(false, `upload ${s.label}`, upErr.message); continue; }
    const { data: pub } = db.storage.from('sponsor-logos').getPublicUrl(path);
    await db.from('sponsors').update({ logo_url: pub.publicUrl, logo_received: true }).eq('id', sp!.id);
    // The uploaded logo must be publicly fetchable (the TV <img> needs this).
    const head = await fetch(pub.publicUrl, { method: 'GET' });
    ok(head.ok, `${s.label} (${s.status}) logo uploaded + publicly reachable`, `HTTP ${head.status}`);
  }

  console.log('\n2. Board returns ALL committed sponsors with their logos (not just paid)');
  const board = await (await fetch(`${BASE}/api/tournament/${tid}/board`, { cache: 'no-store' } as RequestInit)).json();
  const logos = (board.sponsors ?? []) as { company: string; logoUrl: string }[];
  ok(logos.length === 3, 'all 3 committed sponsors surface for rotation', `${logos.length} logos`);
  ok(logos.every((l) => /sponsor-logos/.test(l.logoUrl)), 'each is a real uploaded storage URL');
  ok(logos.some((l) => /Orca/.test(l.company)) && logos.some((l) => /Peak/.test(l.company)), 'invoiced + verbal sponsors included (broadened filter works)');

  console.log(`\n  ► Clubhouse TV (watch the corner logo cycle every 6s):  ${BASE}/tv/${tid}`);
  console.log('  (kept for viewing — run purge when done)');
  console.log(`\n${failures === 0 ? '✅ SPONSOR LOGOS: upload + surface verified' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function purge() {
  console.log('Purging sponsor-logo test…');
  const { data: ts } = await db.from('tournaments').select('id').eq('name', T_NAME);
  for (const t of ts ?? []) {
    // remove uploaded objects for this tournament folder
    const { data: files } = await db.storage.from('sponsor-logos').list(t.id);
    if (files?.length) await db.storage.from('sponsor-logos').remove(files.map((f) => `${t.id}/${f.name}`));
    await db.from('sponsors').delete().eq('tournament_id', t.id);
    await db.from('tournaments').delete().eq('id', t.id);
  }
  const { data: cs } = await db.from('courses').select('id').eq('name', COURSE);
  for (const c of cs ?? []) await db.from('courses').delete().eq('id', c.id);
  const { data: left } = await db.from('tournaments').select('id').eq('name', T_NAME);
  console.log(`Remaining: ${left?.length ?? 0}`);
}

const mode = process.argv[2];
if (mode === 'run') run(); else if (mode === 'purge') purge(); else { console.log('usage: run|purge'); process.exit(1); }
