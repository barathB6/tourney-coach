'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';
import {
  CONTEST_META, CONTEST_TYPES, type ContestType,
  rankByCategory, potCents, payoutBreakdown, parseSplit, dollarsFromCents,
  formatMeasurement, feetInchesToInches, yardsToInches, confirmedWitnessCount, isDecided,
} from '@/lib/contests';

type Witness = { name: string; confirmed: boolean };
type Winner = { name: string; detail: string; place: number };
type Entry = { id: string; player_name: string; category: string | null; value_inches: number | null; raw_label: string | null };
type Contest = {
  id: string;
  hole_number: number | null;
  par: number | null;
  yards: number | null;
  contest_type: ContestType;
  prize: string | null;
  sponsor: string | null;
  notes: string | null;
  location_label: string | null;
  prize_value_cents: number | null;
  insurance_status: 'none' | 'quoted' | 'paid';
  insurance_cost_cents: number | null;
  insurer: string | null;
  witnesses: Witness[];
  verified_at: string | null;
  verification_notes: string | null;
  category_mode: 'open' | 'by_gender' | 'by_age';
  entry_fee_cents: number | null;
  payout_split: string | null;
  winner_name: string | null;
  winner_detail: string | null;
  winners: Winner[];
  decided_at: string | null;
  entries: Entry[];
};

const INSURANCE_META: Record<string, { label: string; fg: string; bg: string }> = {
  none: { label: 'No insurance', fg: '#6B7775', bg: '#F0EDE6' },
  quoted: { label: 'Quote received', fg: '#8A5A00', bg: '#FBF0DC' },
  paid: { label: 'Insured · paid', fg: '#1B6B3A', bg: '#EAF2ED' },
};

function metaLine(c: Contest): string {
  if (c.contest_type === 'putting') return (c.location_label || 'Practice green · pre-round').toUpperCase();
  return [c.hole_number ? `Hole ${c.hole_number}` : null, c.par ? `Par ${c.par}` : null, c.yards ? `${c.yards} yds` : null]
    .filter(Boolean).join(' · ').toUpperCase();
}
function splitLabel(split: string | null): string | null {
  const p = parseSplit(split);
  return p.length ? `${p.map((n) => `${n}%`).join(' / ')} of pot` : null;
}

// The four standard contests, offered as a one-click starter set. Structural
// defaults only (type, a sensible hole, setup notes, putting economics) — prizes,
// sponsors, and any live counts stay empty for the organizer to fill with real
// values, so the manager never ships fabricated operational data.
const DEFAULT_CONTESTS: Record<string, unknown>[] = [
  { contestType: 'hole_in_one', holeNumber: 12, notes: 'Insured prize: 2-year lease, 2026 Toyota Camry. Northshore Toyota.', prizeValueCents: 840000, insurer: 'Northshore Toyota' },
  { contestType: 'closest_to_pin', holeNumber: 5, notes: 'Standard closest-to-pin. Marker on each tee, witnessed by the group.', prize: 'Pro shop $250 gift card', sponsor: 'Lambert & Co. CPAs' },
  { contestType: 'long_drive', holeNumber: 7, categoryMode: 'open', notes: 'Marker placed in the fairway. Players move it as they out-drive.', prize: 'TaylorMade Stealth driver', sponsor: 'Hinckley Roofing' },
  { contestType: 'putting', locationLabel: 'Practice green · pre-round', entryFeeCents: 1000, payoutSplit: '60/30/10', notes: '$10 add-on at registration. Single-putt at 30 ft. Top 3 split the pot.' },
];

export default function ContestsPage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [fieldSize, setFieldSize] = useState<number | null>(null);
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const fetchContests = useCallback(async (tid: string) => {
    const res = await authedFetch(`/api/tournament/${tid}/contests`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error || 'Could not load contests'); return; }
    setContests((data.contests ?? []) as Contest[]);
    setFieldSize(data.fieldSize ?? null);
    setError('');
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/contests'); return; }
      const { data: t } = await supabase
        .from('tournaments').select('id').eq('organizer_id', user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!t) { setLoading(false); return; }
      setTournamentId(t.id);
      await fetchContests(t.id);
      setLoading(false);
    });
  }, [router, fetchContests]);

  useEffect(() => {
    if (!tournamentId) return;
    const channel = supabase.channel(`contests:${tournamentId}`)
      .on('broadcast', { event: 'contest' }, () => fetchContests(tournamentId))
      .subscribe();
    const poll = setInterval(() => fetchContests(tournamentId), 20000);
    return () => { supabase.removeChannel(channel); clearInterval(poll); };
  }, [tournamentId, fetchContests]);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    if (!tournamentId) return;
    await authedFetch(`/api/tournament/${tournamentId}/contests`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await fetchContests(tournamentId);
  }, [tournamentId, fetchContests]);

  const removeContest = useCallback(async (id: string) => {
    if (!tournamentId || !confirm('Delete this contest and its entries?')) return;
    await authedFetch(`/api/tournament/${tournamentId}/contests?id=${id}`, { method: 'DELETE' });
    await fetchContests(tournamentId);
  }, [tournamentId, fetchContests]);

  const addEntry = useCallback(async (body: Record<string, unknown>) => {
    if (!tournamentId) return;
    await authedFetch(`/api/tournament/${tournamentId}/contests/entries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await fetchContests(tournamentId);
  }, [tournamentId, fetchContests]);

  const removeEntry = useCallback(async (entryId: string) => {
    if (!tournamentId) return;
    await authedFetch(`/api/tournament/${tournamentId}/contests/entries?id=${entryId}`, { method: 'DELETE' });
    await fetchContests(tournamentId);
  }, [tournamentId, fetchContests]);

  // Apply the standard set: patch the example config onto a matching existing
  // contest (so the four you already seeded fill in), or create it if missing.
  const addDefaults = useCallback(async () => {
    if (!tournamentId || seeding) return;
    setSeeding(true);
    const url = `/api/tournament/${tournamentId}/contests`;
    for (const d of DEFAULT_CONTESTS) {
      const existing = contests.find((c) => c.contest_type === d.contestType && (d.contestType === 'putting' || c.hole_number === d.holeNumber));
      if (existing) {
        await authedFetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: existing.id, ...d }) });
      } else {
        await authedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      }
    }
    await fetchContests(tournamentId);
    setSeeding(false);
  }, [tournamentId, seeding, contests, fetchContests]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '26px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

        {/* Header — eyebrow + title + subtitle */}
        <div style={{ margin: '14px 0 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--primary)' }}>Module 13</span>
            <span style={S.moduleTag}>PO · MVP</span>
          </div>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 40, lineHeight: 1.05, color: 'var(--ink)', margin: '0 0 12px' }}>Contest Hole Manager</h1>
          <p style={{ fontSize: 16, lineHeight: 1.5, color: '#5C6B62', maxWidth: 620, margin: 0 }}>
            Hole-in-one insurance, closest to pin, longest drive, putting contest. One card per contest. Each card knows which hole it lives on, what the prize is, who the witnesses are, and how it gets photographed.
          </p>
        </div>

        {/* Content */}
        <div>
            {loading ? (
              <p style={{ color: '#8A9089' }}>Loading contests…</p>
            ) : !tournamentId ? (
              <EmptyState onSetup={() => router.push('/setup/format')} />
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
                  <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 26, color: 'var(--ink)', margin: 0 }}>
                    Contest holes — {contests.length} active
                  </h2>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button style={{ ...S.ghostBtn, opacity: seeding ? 0.6 : 1 }} onClick={addDefaults} disabled={seeding} title="Fill the four standard contests with example prize & sponsor">
                      {seeding ? 'Applying…' : '↺ Standard set'}
                    </button>
                    <button style={S.addBtn} onClick={() => setAdding(true)}>+ Add contest</button>
                  </div>
                </div>

                {error && <p style={{ color: 'var(--alert)', fontSize: 13 }}>{error}</p>}

                {contests.length === 0 ? (
                  <div style={{ padding: '32px 0', textAlign: 'center' }}>
                    <p style={{ color: '#8A9089', margin: '0 0 16px' }}>No contest holes yet. Start with the four standard contests, then fill in your prizes and sponsors.</p>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                      <button style={{ ...S.addBtn, opacity: seeding ? 0.6 : 1 }} onClick={addDefaults} disabled={seeding}>{seeding ? 'Adding…' : '+ Add the four standard contests'}</button>
                      <button style={S.ghostBtn} onClick={() => setAdding(true)}>Add one manually</button>
                    </div>
                  </div>
                ) : (
                  <div style={S.grid}>
                    {contests.map((c, i) => (
                      <ContestCard key={c.id} contest={c} fieldSize={fieldSize}
                        featured={i === 0 || isDecided(c)} onOpen={() => setManageId(c.id)} />
                    ))}
                  </div>
                )}
              </>
            )}
        </div>

        <WinnersSummary contests={contests} />
      </div>

      {adding && tournamentId && (
        <AddContestModal
          onClose={() => setAdding(false)}
          onCreate={async (body) => {
            const res = await authedFetch(`/api/tournament/${tournamentId}/contests`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) return d.error || 'Could not create contest';
            await fetchContests(tournamentId);
            setAdding(false);
            return null;
          }}
        />
      )}

      {manageId && (() => {
        const c = contests.find((x) => x.id === manageId);
        return c ? (
          <ManageModal contest={c} fieldSize={fieldSize} onPatch={patch} onAddEntry={addEntry} onRemoveEntry={removeEntry}
            onDelete={async () => { await removeContest(c.id); setManageId(null); }} onClose={() => setManageId(null)} />
        ) : null;
      })()}
    </div>
  );
}

function EmptyState({ onSetup }: { onSetup: () => void }) {
  return (
    <div style={{ padding: '28px 0', display: 'grid', gap: 12, justifyItems: 'start' }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: 'var(--deep-green)', margin: 0 }}>No tournament yet</h2>
      <p style={{ color: '#6B7775', margin: 0 }}>Set up your event first, then come back to add contest holes.</p>
      <button style={S.addBtn} onClick={onSetup}>Set up your event →</button>
    </div>
  );
}

// ── Card (clean face; click to manage) ──
function ContestCard({ contest: c, fieldSize, featured, onOpen }: {
  contest: Contest; fieldSize: number | null; featured: boolean; onOpen: () => void;
}) {
  const meta = CONTEST_META[c.contest_type];
  const decided = isDecided(c);

  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(); }}
      style={{ ...S.card, ...(featured ? S.cardFeatured : {}), cursor: 'pointer' }}>
      <div style={{ ...S.iconTile, background: featured ? 'var(--primary)' : '#E9F0EA' }}><span style={{ fontSize: 22 }}>{meta.icon}</span></div>

      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 21, color: 'var(--ink)', margin: '14px 0 4px' }}>{meta.label}</h3>
      <p style={S.meta}>{metaLine(c)}</p>
      {c.notes && <p style={{ fontSize: 13.5, color: '#4A524C', lineHeight: 1.5, margin: '12px 0 0' }}>{c.notes}</p>}

      <div style={{ borderTop: '1px solid var(--line)', margin: '16px 0 0', paddingTop: 14, display: 'grid', gap: 6 }}>
        {c.contest_type === 'hole_in_one' && <>
          {c.prize_value_cents != null ? <SumRow label="Prize" value={`~${dollarsFromCents(c.prize_value_cents)} retail`} /> : c.prize && <SumRow label="Prize" value={c.prize} />}
          {(c.insurance_cost_cents != null || c.insurance_status !== 'none') && (
            <SumRow label="Insurance" value={`${c.insurance_cost_cents != null ? dollarsFromCents(c.insurance_cost_cents) + ' ' : ''}(${c.insurance_status})`} />
          )}
          <SumRow label="Witnesses" value={`${confirmedWitnessCount(c.witnesses)} confirmed`} />
        </>}
        {(c.contest_type === 'closest_to_pin' || c.contest_type === 'long_drive') && <>
          {c.prize && <SumRow label="Prize" value={c.prize} />}
          {c.sponsor && <SumRow label="Sponsor" value={c.sponsor} />}
        </>}
        {c.contest_type === 'putting' && <>
          {splitLabel(c.payout_split) ? <SumRow label="Prize" value={splitLabel(c.payout_split)!} /> : c.prize && <SumRow label="Prize" value={c.prize} />}
          <SumRow label="Add-ons sold" value={fieldSize ? `${c.entries.length} of ${fieldSize}` : `${c.entries.length}`} />
        </>}
      </div>

      {decided && (
        <div style={S.decidedTag}>
          ✓ {c.contest_type === 'putting' ? `${c.winners.length} placed` : `${c.winner_name}${c.winner_detail ? ` · ${c.winner_detail}` : ''}`}
        </div>
      )}
    </div>
  );
}

// ── Manage modal (opened by clicking a card) ──
function ManageModal({ contest: c, fieldSize, onPatch, onDelete, onAddEntry, onRemoveEntry, onClose }: {
  contest: Contest; fieldSize: number | null;
  onPatch: (b: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
  onAddEntry: (b: Record<string, unknown>) => Promise<void>;
  onRemoveEntry: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const meta = CONTEST_META[c.contest_type];
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
          <div style={{ ...S.iconTile, background: 'var(--primary)' }}><span style={{ fontSize: 20 }}>{meta.icon}</span></div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 21, color: 'var(--ink)', margin: 0 }}>{meta.label}</h2>
            <p style={{ ...S.meta, marginTop: 2 }}>{metaLine(c)}</p>
          </div>
          <button onClick={onClose} style={S.del}>✕</button>
        </div>

        {c.contest_type === 'hole_in_one' && <HoleInOnePanel c={c} onPatch={onPatch} />}
        {(c.contest_type === 'closest_to_pin' || c.contest_type === 'long_drive') && <LeaderboardPanel c={c} onAddEntry={onAddEntry} onRemoveEntry={onRemoveEntry} onPatch={onPatch} />}
        {c.contest_type === 'putting' && <PuttingPanel c={c} fieldSize={fieldSize} onAddEntry={onAddEntry} onRemoveEntry={onRemoveEntry} onPatch={onPatch} />}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <button onClick={onDelete} style={{ ...S.ghostBtn, color: 'var(--alert)', borderColor: '#E7C3BA' }}>Delete contest</button>
          <button onClick={onClose} style={S.addBtn}>Done</button>
        </div>
      </div>
    </div>
  );
}

function SumRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{label}:</span> <span style={{ color: '#4A524C' }}>{value}</span>
    </div>
  );
}

// ── Hole-in-one operations ──
function HoleInOnePanel({ c, onPatch }: { c: Contest; onPatch: (b: Record<string, unknown>) => Promise<void> }) {
  const [wname, setWName] = useState('');
  const [winner, setWinner] = useState(c.winner_name ?? '');
  const [detail, setDetail] = useState(c.winner_detail ?? '');
  const ins = INSURANCE_META[c.insurance_status] ?? INSURANCE_META.none;
  const confirmed = confirmedWitnessCount(c.witnesses);

  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Insurance</span>
        <span style={{ ...S.pill, color: ins.fg, background: ins.bg }}>{ins.label}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {(['none', 'quoted', 'paid'] as const).map((s) => (
          <button key={s} onClick={() => onPatch({ id: c.id, insuranceStatus: s })} style={{ ...S.miniBtn, ...(c.insurance_status === s ? S.miniBtnOn : {}) }}>
            {s === 'none' ? 'Uninsured' : s === 'quoted' ? 'Quoted' : 'Paid'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Witnesses</span>
        <span style={{ color: confirmed >= 2 ? 'var(--primary)' : '#8A9089' }}>{confirmed} confirmed</span>
      </div>
      {c.witnesses.map((w, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => onPatch({ id: c.id, witnesses: c.witnesses.map((x, xi) => xi === i ? { ...x, confirmed: !x.confirmed } : x) })} style={{ ...S.check, ...(w.confirmed ? S.checkOn : {}) }}>{w.confirmed ? '✓' : ''}</button>
          <span style={{ flex: 1, color: 'var(--ink)' }}>{w.name}</span>
          <button onClick={() => onPatch({ id: c.id, witnesses: c.witnesses.filter((_, xi) => xi !== i) })} style={S.del}>✕</button>
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (wname.trim()) { onPatch({ id: c.id, witnesses: [...c.witnesses, { name: wname.trim(), confirmed: false }] }); setWName(''); } }} style={{ display: 'flex', gap: 6 }}>
        <input value={wname} onChange={(e) => setWName(e.target.value)} placeholder="Add witness…" style={S.input} />
        <button type="submit" style={S.miniBtn}>Add</button>
      </form>

      <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 8, marginTop: 4, display: 'grid', gap: 6 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Record the ace</span>
        <input value={winner} onChange={(e) => setWinner(e.target.value)} placeholder="Winner name" style={S.input} />
        <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder='Detail — e.g. "2:40pm, group 7"' style={S.input} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => onPatch({ id: c.id, winnerName: winner, winnerDetail: detail })} disabled={!winner.trim()} style={{ ...S.miniBtn, ...S.miniBtnOn, opacity: winner.trim() ? 1 : 0.5 }}>Record winner</button>
          <button onClick={() => onPatch({ id: c.id, verified: !c.verified_at })} style={{ ...S.miniBtn, ...(c.verified_at ? S.miniBtnOn : {}) }}>{c.verified_at ? '✓ Verified' : 'Mark verified'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Closest-to-pin / long-drive leaderboard ──
function LeaderboardPanel({ c, onAddEntry, onRemoveEntry, onPatch }: {
  c: Contest;
  onAddEntry: (b: Record<string, unknown>) => Promise<void>;
  onRemoveEntry: (id: string) => Promise<void>;
  onPatch: (b: Record<string, unknown>) => Promise<void>;
}) {
  const isLD = c.contest_type === 'long_drive';
  const groups = useMemo(() => rankByCategory(c.entries, c.contest_type, isLD && c.category_mode !== 'open'), [c.entries, c.contest_type, isLD, c.category_mode]);
  const [name, setName] = useState('');
  const [feet, setFeet] = useState('');
  const [inch, setInch] = useState('');
  const [yards, setYards] = useState('');
  const [cat, setCat] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    let valueInches: number, rawLabel: string;
    if (isLD) {
      const y = Number(yards); if (!Number.isFinite(y) || y <= 0) return;
      valueInches = yardsToInches(y); rawLabel = `${Math.round(y)} yds`;
    } else {
      const f = Number(feet) || 0, i = Number(inch) || 0; if (f <= 0 && i <= 0) return;
      valueInches = feetInchesToInches(f, i); rawLabel = formatMeasurement(valueInches, c.contest_type);
    }
    onAddEntry({ contestHoleId: c.id, playerName: name.trim(), valueInches, rawLabel, category: isLD && c.category_mode !== 'open' ? (cat.trim() || null) : null });
    setName(''); setFeet(''); setInch(''); setYards('');
  };
  const leader = groups[0]?.entries[0];

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
      {groups.every((g) => g.entries.length === 0)
        ? <p style={{ fontSize: 12.5, color: '#8A9089', margin: 0 }}>No entries yet — add the first measurement.</p>
        : groups.map((g) => (
          <div key={g.category}>
            {isLD && c.category_mode !== 'open' && <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', margin: '2px 0' }}>{g.category}</p>}
            {g.entries.slice(0, 5).map((e) => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{ width: 18, textAlign: 'right', color: e.rank === 1 ? 'var(--gold)' : '#8A9089', fontFamily: "'Fraunces', serif" }}>{e.rank}</span>
                <span style={{ flex: 1, color: 'var(--ink)' }}>{e.player_name}</span>
                <span style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{e.raw_label || formatMeasurement(e.value_inches, c.contest_type)}</span>
                <button onClick={() => onRemoveEntry(e.id)} style={S.del}>✕</button>
              </div>
            ))}
          </div>
        ))}
      <form onSubmit={submit} style={{ display: 'grid', gap: 6, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player name" style={S.input} />
        {isLD ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={yards} onChange={(e) => setYards(e.target.value)} inputMode="numeric" placeholder="Yards" style={S.input} />
            {c.category_mode !== 'open' && <input value={cat} onChange={(e) => setCat(e.target.value)} placeholder={c.category_mode === 'by_gender' ? "Men's / Women's" : 'Age group'} style={S.input} />}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={feet} onChange={(e) => setFeet(e.target.value)} inputMode="numeric" placeholder="Feet" style={S.input} />
            <input value={inch} onChange={(e) => setInch(e.target.value)} inputMode="numeric" placeholder="Inches" style={S.input} />
          </div>
        )}
        <button type="submit" style={S.miniBtn}>Add entry</button>
      </form>
      {leader && (
        <button onClick={() => onPatch({ id: c.id, winnerName: leader.player_name, winnerDetail: leader.raw_label || formatMeasurement(leader.value_inches, c.contest_type) })} style={{ ...S.miniBtn, ...S.miniBtnOn }}>
          Record leader ({leader.player_name})
        </button>
      )}
    </div>
  );
}

// ── Putting ──
function PuttingPanel({ c, fieldSize, onAddEntry, onRemoveEntry, onPatch }: {
  c: Contest; fieldSize: number | null;
  onAddEntry: (b: Record<string, unknown>) => Promise<void>;
  onRemoveEntry: (id: string) => Promise<void>;
  onPatch: (b: Record<string, unknown>) => Promise<void>;
}) {
  const entrants = c.entries.length;
  const pot = potCents(c.entry_fee_cents, entrants);
  const payout = payoutBreakdown(pot, c.payout_split);
  const [name, setName] = useState('');
  const [w1, setW1] = useState(c.winners[0]?.name ?? '');
  const [w2, setW2] = useState(c.winners[1]?.name ?? '');
  const [w3, setW3] = useState(c.winners[2]?.name ?? '');
  const save = () => onPatch({ id: c.id, winners: [w1, w2, w3].map((n, i) => ({ name: n.trim(), detail: payout[i] ? dollarsFromCents(payout[i].cents) : '', place: i + 1 })).filter((w) => w.name) });

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#8A9089', fontWeight: 600 }}>Entry fee</span><span>{c.entry_fee_cents != null ? `${dollarsFromCents(c.entry_fee_cents)} add-on` : '—'}</span></div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#8A9089', fontWeight: 600 }}>Pot</span><span style={{ fontWeight: 700 }}>{dollarsFromCents(pot)}</span></div>
      {payout.map((p) => (
        <div key={p.place} style={{ display: 'flex', justifyContent: 'space-between', color: '#4A524C' }}>
          <span>{['1st', '2nd', '3rd', '4th', '5th'][p.place - 1] ?? `${p.place}th`} · {p.pct}%</span><span>{dollarsFromCents(p.cents)}</span>
        </div>
      ))}
      <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 8, display: 'grid', gap: 4 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Entrants ({entrants}{fieldSize ? ` of ${fieldSize}` : ''})</span>
        {c.entries.slice(0, 6).map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1 }}>{e.player_name}</span><button onClick={() => onRemoveEntry(e.id)} style={S.del}>✕</button></div>
        ))}
        {c.entries.length > 6 && <span style={{ fontSize: 11, color: '#8A9089' }}>+{c.entries.length - 6} more</span>}
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onAddEntry({ contestHoleId: c.id, playerName: name.trim() }); setName(''); } }} style={{ display: 'flex', gap: 6 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add entrant…" style={S.input} />
          <button type="submit" style={S.miniBtn}>Add</button>
        </form>
      </div>
      <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 8, display: 'grid', gap: 4 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Top 3</span>
        <input value={w1} onChange={(e) => setW1(e.target.value)} placeholder={`1st${payout[0] ? ` · ${dollarsFromCents(payout[0].cents)}` : ''}`} style={S.input} />
        <input value={w2} onChange={(e) => setW2(e.target.value)} placeholder={`2nd${payout[1] ? ` · ${dollarsFromCents(payout[1].cents)}` : ''}`} style={S.input} />
        <input value={w3} onChange={(e) => setW3(e.target.value)} placeholder={`3rd${payout[2] ? ` · ${dollarsFromCents(payout[2].cents)}` : ''}`} style={S.input} />
        <button onClick={save} style={{ ...S.miniBtn, ...S.miniBtnOn }}>Save winners</button>
      </div>
    </div>
  );
}

// ── Winners summary ──
function WinnersSummary({ contests }: { contests: Contest[] }) {
  const decided = contests.filter(isDecided);
  if (decided.length === 0) return null;
  return (
    <div style={{ marginTop: 26, background: 'var(--deep-green)', borderRadius: 16, padding: '22px 24px', color: '#fff' }}>
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--gold)', margin: '0 0 4px' }}>Ready for the awards ceremony</p>
      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, margin: '0 0 14px' }}>Contest winners</h3>
      <div style={{ display: 'grid', gap: 10 }}>
        {decided.map((c) => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: 8 }}>
            <span style={{ color: 'rgba(255,255,255,0.75)' }}>{CONTEST_META[c.contest_type].icon} {CONTEST_META[c.contest_type].label}{c.hole_number ? ` · Hole ${c.hole_number}` : ''}</span>
            <span style={{ textAlign: 'right', fontWeight: 600 }}>
              {c.contest_type === 'putting' ? c.winners.map((w) => `${w.place}. ${w.name}`).join('  ·  ') : `${c.winner_name}${c.winner_detail ? ` — ${c.winner_detail}` : ''}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Add-contest modal ──
function AddContestModal({ onClose, onCreate }: { onClose: () => void; onCreate: (b: Record<string, unknown>) => Promise<string | null> }) {
  const [type, setType] = useState<ContestType>('hole_in_one');
  const [hole, setHole] = useState('');
  const [prize, setPrize] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [notes, setNotes] = useState('');
  const [locationLabel, setLocationLabel] = useState('Practice green · pre-round');
  const [prizeValue, setPrizeValue] = useState('');
  const [insurer, setInsurer] = useState('');
  const [insuranceCost, setInsuranceCost] = useState('');
  const [categoryMode, setCategoryMode] = useState<'open' | 'by_gender' | 'by_age'>('open');
  const [entryFee, setEntryFee] = useState('10');
  const [payoutSplit, setPayoutSplit] = useState('60/30/10');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const needsHole = type !== 'putting';
  const toCents = (v: string) => { const n = Math.round(parseFloat(v) * 100); return Number.isFinite(n) && n >= 0 ? n : null; };

  const submit = async () => {
    setErr(''); setBusy(true);
    const body: Record<string, unknown> = { contestType: type, prize: prize || null, sponsor: sponsor || null, notes: notes || null };
    if (needsHole) body.holeNumber = Number(hole);
    if (type === 'hole_in_one') { body.prizeValueCents = toCents(prizeValue); body.insurer = insurer || null; body.insuranceCostCents = toCents(insuranceCost); }
    if (type === 'long_drive') body.categoryMode = categoryMode;
    if (type === 'putting') { body.locationLabel = locationLabel || null; body.entryFeeCents = toCents(entryFee); body.payoutSplit = payoutSplit || null; }
    const msg = await onCreate(body);
    setBusy(false);
    if (msg) setErr(msg);
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: 'var(--deep-green)', margin: '0 0 4px' }}>Add a contest</h2>
        <p style={{ color: '#6B7775', fontSize: 13, margin: '0 0 16px' }}>Pick a type, then fill in the details.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {CONTEST_TYPES.map((t) => (
            <button key={t} onClick={() => setType(t)} style={{ ...S.typeBtn, ...(type === t ? S.typeBtnOn : {}) }}><span style={{ fontSize: 17 }}>{CONTEST_META[t].icon}</span> {CONTEST_META[t].label}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {needsHole && <Field label="Hole number (1–18)"><input value={hole} onChange={(e) => setHole(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 12" style={S.input} /></Field>}
          {type === 'putting' && <Field label="Location / timing"><input value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} style={S.input} /></Field>}
          <Field label="Prize"><input value={prize} onChange={(e) => setPrize(e.target.value)} placeholder="e.g. Pro shop $250 gift card" style={S.input} /></Field>
          <Field label="Sponsor (optional)"><input value={sponsor} onChange={(e) => setSponsor(e.target.value)} placeholder="e.g. Lambert & Co. CPAs" style={S.input} /></Field>
          <Field label="Notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Marker on each tee, witnessed by group" style={S.input} /></Field>
          {type === 'hole_in_one' && <>
            <Field label="Prize retail value"><Money value={prizeValue} onChange={setPrizeValue} placeholder="8400" /></Field>
            <Field label="Insurer (optional)"><input value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="e.g. Northshore Toyota via HIO Inc." style={S.input} /></Field>
            <Field label="Insurance cost"><Money value={insuranceCost} onChange={setInsuranceCost} placeholder="475" /></Field>
          </>}
          {type === 'long_drive' && <Field label="Leaderboard split">
            <div style={{ display: 'flex', gap: 6 }}>{(['open', 'by_gender', 'by_age'] as const).map((m) => (
              <button key={m} onClick={() => setCategoryMode(m)} style={{ ...S.miniBtn, ...(categoryMode === m ? S.miniBtnOn : {}) }}>{m === 'open' ? 'Overall' : m === 'by_gender' ? 'By gender' : 'By age'}</button>
            ))}</div>
          </Field>}
          {type === 'putting' && <>
            <Field label="Entry fee (add-on)"><Money value={entryFee} onChange={setEntryFee} placeholder="10" /></Field>
            <Field label="Payout split"><input value={payoutSplit} onChange={(e) => setPayoutSplit(e.target.value)} placeholder="60/30/10" style={S.input} /></Field>
          </>}
        </div>
        {err && <p style={{ color: 'var(--alert)', fontSize: 13, marginTop: 12 }}>{err}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={S.ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy || (needsHole && !hole)} style={{ ...S.addBtn, opacity: busy || (needsHole && !hole) ? 0.5 : 1 }}>{busy ? 'Adding…' : 'Add contest'}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block' }}><span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{label}</span>{children}</label>;
}
function Money({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ color: 'var(--ink)', fontWeight: 600 }}>$</span><input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder={placeholder} style={S.input} /></div>;
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  moduleTag: { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#8A6D1F', background: '#F3E6C4', borderRadius: 6, padding: '3px 8px' },
  addBtn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 16px', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))', gap: 16 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: 18 },
  cardFeatured: { background: '#F1F7F2', borderColor: 'var(--primary)' },
  iconTile: { width: 46, height: 46, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  del: { background: 'none', border: 'none', color: '#C5CAC2', cursor: 'pointer', fontSize: 12, padding: 2, lineHeight: 1 },
  meta: { fontSize: 11.5, fontWeight: 700, letterSpacing: 0.7, color: '#8A9089', margin: 0 },
  decidedTag: { marginTop: 12, background: '#EAF2ED', color: 'var(--primary)', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontWeight: 600 },
  pill: { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px' },
  miniBtn: { background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' },
  miniBtnOn: { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' },
  check: { width: 22, height: 22, borderRadius: 6, border: '1.5px solid #B9C4BC', background: '#fff', color: '#fff', cursor: 'pointer', fontSize: 12, lineHeight: 1 },
  checkOn: { background: 'var(--primary)', borderColor: 'var(--primary)' },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'var(--ink)', background: '#fff', outline: 'none', boxSizing: 'border-box' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,30,20,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', zIndex: 50, overflowY: 'auto' },
  modal: { background: 'var(--cream)', borderRadius: 18, padding: 24, width: '100%', maxWidth: 460 },
  typeBtn: { display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px', fontSize: 13, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' },
  typeBtnOn: { background: 'var(--deep-green)', borderColor: 'var(--deep-green)', color: '#fff' },
};
