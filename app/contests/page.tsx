'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';
import {
  CONTEST_META, CONTEST_TYPES, type ContestType,
  rankByCategory, potCents, payoutBreakdown, dollarsFromCents,
  formatMeasurement, feetInchesToInches, yardsToInches, confirmedWitnessCount, isDecided,
} from '@/lib/contests';

type Witness = { name: string; confirmed: boolean };
type Winner = { name: string; detail: string; place: number };
type Entry = { id: string; player_name: string; category: string | null; value_inches: number | null; raw_label: string | null };
type Contest = {
  id: string;
  hole_number: number | null;
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

export default function ContestsPage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [tournamentName, setTournamentName] = useState('');
  const [fieldSize, setFieldSize] = useState<number | null>(null);
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

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
        .from('tournaments').select('id, name').eq('organizer_id', user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!t) { setLoading(false); return; }
      setTournamentId(t.id);
      setTournamentName(t.name);
      await fetchContests(t.id);
      setLoading(false);
    });
  }, [router, fetchContests]);

  // Live updates: any entry / winner / config change on this tournament pushes
  // on contests:<tid>; refetch. A 20s poll covers any missed broadcast.
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

  const decidedCount = contests.filter((c) => isDecided(c)).length;

  if (loading) return <Shell><p style={{ color: '#6B7775' }}>Loading contests…</p></Shell>;
  if (!tournamentId) {
    return (
      <Shell>
        <div style={S.empty}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: 'var(--deep-green)', margin: '0 0 8px' }}>No tournament yet</h2>
          <p style={{ color: '#6B7775', margin: 0 }}>Set up your event first, then come back to add contest holes.</p>
          <button style={S.primaryBtn} onClick={() => router.push('/setup/format')}>Set up your event →</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell name={tournamentName}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, color: 'var(--ink)', margin: 0 }}>
            Contest holes — {contests.length} {contests.length === 1 ? 'contest' : 'contests'}
          </h2>
          <p style={{ color: '#6B7775', fontSize: 13, margin: '4px 0 0' }}>
            {decidedCount} decided · {contests.length - decidedCount} still open
          </p>
        </div>
        <button style={S.primaryBtn} onClick={() => setAdding(true)}>+ Add contest</button>
      </div>

      {error && <p style={{ color: 'var(--alert)', fontSize: 13 }}>{error}</p>}

      {contests.length === 0 ? (
        <div style={S.empty}>
          <p style={{ color: '#6B7775', margin: 0 }}>No contest holes yet. Hole-in-one, closest-to-pin, longest drive, and a putting contest are the extras that make the day.</p>
          <button style={S.primaryBtn} onClick={() => setAdding(true)}>+ Add your first contest</button>
        </div>
      ) : (
        <div style={S.grid}>
          {contests.map((c) => (
            <ContestCard
              key={c.id} contest={c} fieldSize={fieldSize}
              onPatch={patch} onDelete={() => removeContest(c.id)}
              onAddEntry={addEntry} onRemoveEntry={removeEntry}
            />
          ))}
        </div>
      )}

      <WinnersSummary contests={contests} />

      {adding && (
        <AddContestModal
          existing={contests}
          onClose={() => setAdding(false)}
          onCreate={async (body) => {
            if (!tournamentId) return;
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
    </Shell>
  );
}

// ── Page shell ──
function Shell({ children, name }: { children: React.ReactNode; name?: string }) {
  const router = useRouter();
  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 1160, margin: '0 auto', padding: '28px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>
        <div style={{ margin: '10px 0 22px' }}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--primary)', margin: 0 }}>Module 13 · Day-of</p>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 34, color: 'var(--deep-green)', margin: '2px 0 2px' }}>Contest Hole Manager</h1>
          {name && <p style={{ color: '#6B7775', fontSize: 14, margin: 0 }}>{name}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

// ── One contest card ──
function ContestCard({ contest: c, fieldSize, onPatch, onDelete, onAddEntry, onRemoveEntry }: {
  contest: Contest; fieldSize: number | null;
  onPatch: (b: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
  onAddEntry: (b: Record<string, unknown>) => Promise<void>;
  onRemoveEntry: (id: string) => Promise<void>;
}) {
  const meta = CONTEST_META[c.contest_type];
  const decided = isDecided(c);
  const where = c.hole_number ? `Hole ${c.hole_number}` : (c.location_label || 'Practice green');

  return (
    <div style={{ ...S.card, ...(decided ? S.cardDecided : {}) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={S.iconBox}><span style={{ fontSize: 22 }}>{meta.icon}</span></div>
        <button title="Delete contest" onClick={onDelete} style={S.iconGhost}>✕</button>
      </div>

      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, color: 'var(--ink)', margin: '12px 0 2px' }}>{meta.label}</h3>
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#8A9089', margin: '0 0 10px' }}>
        {where}{c.contest_type === 'putting' && c.location_label && c.hole_number ? '' : ''}
      </p>

      {c.notes && <p style={{ fontSize: 13, color: '#4A524C', lineHeight: 1.5, margin: '0 0 12px' }}>{c.notes}</p>}

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'grid', gap: 4, fontSize: 13 }}>
        {c.prize && <Row label="Prize" value={c.prize} />}
        {c.sponsor && <Row label="Sponsor" value={c.sponsor} />}
        {c.contest_type === 'hole_in_one' && <HoleInOnePanel c={c} onPatch={onPatch} />}
        {(c.contest_type === 'closest_to_pin' || c.contest_type === 'long_drive') && (
          <LeaderboardPanel c={c} onAddEntry={onAddEntry} onRemoveEntry={onRemoveEntry} onPatch={onPatch} />
        )}
        {c.contest_type === 'putting' && <PuttingPanel c={c} fieldSize={fieldSize} onAddEntry={onAddEntry} onRemoveEntry={onRemoveEntry} onPatch={onPatch} />}
      </div>

      {decided && (
        <div style={S.decidedTag}>
          ✓ Winner: {c.contest_type === 'putting'
            ? `${c.winners.length} placed`
            : `${c.winner_name}${c.winner_detail ? ` · ${c.winner_detail}` : ''}`}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ color: '#8A9089', fontWeight: 600 }}>{label}</span>
      <span style={{ color: 'var(--ink)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// ── Hole-in-one: insurance + witnesses + verify + winner ──
function HoleInOnePanel({ c, onPatch }: { c: Contest; onPatch: (b: Record<string, unknown>) => Promise<void> }) {
  const [wname, setWName] = useState('');
  const [winner, setWinner] = useState(c.winner_name ?? '');
  const [detail, setDetail] = useState(c.winner_detail ?? '');
  const ins = INSURANCE_META[c.insurance_status] ?? INSURANCE_META.none;
  const confirmed = confirmedWitnessCount(c.witnesses);

  return (
    <>
      {c.prize_value_cents != null && <Row label="Prize value" value={`${dollarsFromCents(c.prize_value_cents)} retail`} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Insurance</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...S.pill, color: ins.fg, background: ins.bg }}>{ins.label}</span>
          {c.insurance_cost_cents != null && <span style={{ color: 'var(--ink)' }}>{dollarsFromCents(c.insurance_cost_cents)}</span>}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {(['none', 'quoted', 'paid'] as const).map((s) => (
          <button key={s} onClick={() => onPatch({ id: c.id, insuranceStatus: s })}
            style={{ ...S.miniBtn, ...(c.insurance_status === s ? S.miniBtnOn : {}) }}>
            {s === 'none' ? 'Uninsured' : s === 'quoted' ? 'Quoted' : 'Paid'}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#8A9089', fontWeight: 600 }}>Witnesses</span>
          <span style={{ color: confirmed >= 2 ? 'var(--primary)' : '#8A9089' }}>{confirmed} confirmed</span>
        </div>
        {c.witnesses.map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <button onClick={() => onPatch({ id: c.id, witnesses: c.witnesses.map((x, xi) => xi === i ? { ...x, confirmed: !x.confirmed } : x) })}
              style={{ ...S.check, ...(w.confirmed ? S.checkOn : {}) }}>{w.confirmed ? '✓' : ''}</button>
            <span style={{ flex: 1, color: 'var(--ink)' }}>{w.name}</span>
            <button onClick={() => onPatch({ id: c.id, witnesses: c.witnesses.filter((_, xi) => xi !== i) })} style={S.iconGhost}>✕</button>
          </div>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); if (wname.trim()) { onPatch({ id: c.id, witnesses: [...c.witnesses, { name: wname.trim(), confirmed: false }] }); setWName(''); } }}
          style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input value={wname} onChange={(e) => setWName(e.target.value)} placeholder="Add witness…" style={S.input} />
          <button type="submit" style={S.miniBtn}>Add</button>
        </form>
      </div>

      <div style={{ marginTop: 10, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
        <span style={{ color: '#8A9089', fontWeight: 600 }}>Record the ace</span>
        <input value={winner} onChange={(e) => setWinner(e.target.value)} placeholder="Winner name" style={{ ...S.input, marginTop: 4 }} />
        <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder='Detail — e.g. "Hole 12, 2:40pm"' style={{ ...S.input, marginTop: 4 }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button onClick={() => onPatch({ id: c.id, winnerName: winner, winnerDetail: detail })} disabled={!winner.trim()}
            style={{ ...S.miniBtn, ...S.miniBtnOn, opacity: winner.trim() ? 1 : 0.5 }}>Record winner</button>
          <button onClick={() => onPatch({ id: c.id, verified: !c.verified_at })}
            style={{ ...S.miniBtn, ...(c.verified_at ? S.miniBtnOn : {}) }}>{c.verified_at ? '✓ Verified' : 'Mark verified'}</button>
        </div>
      </div>
    </>
  );
}

// ── Closest-to-pin / long-drive live leaderboard ──
function LeaderboardPanel({ c, onAddEntry, onRemoveEntry, onPatch }: {
  c: Contest;
  onAddEntry: (b: Record<string, unknown>) => Promise<void>;
  onRemoveEntry: (id: string) => Promise<void>;
  onPatch: (b: Record<string, unknown>) => Promise<void>;
}) {
  const isLD = c.contest_type === 'long_drive';
  const groups = useMemo(
    () => rankByCategory(c.entries, c.contest_type, isLD && c.category_mode !== 'open'),
    [c.entries, c.contest_type, isLD, c.category_mode],
  );
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
      const y = Number(yards);
      if (!Number.isFinite(y) || y <= 0) return;
      valueInches = yardsToInches(y); rawLabel = `${Math.round(y)} yds`;
    } else {
      const f = Number(feet) || 0, i = Number(inch) || 0;
      if (f <= 0 && i <= 0) return;
      valueInches = feetInchesToInches(f, i); rawLabel = formatMeasurement(valueInches, c.contest_type);
    }
    onAddEntry({ contestHoleId: c.id, playerName: name.trim(), valueInches, rawLabel, category: isLD && c.category_mode !== 'open' ? (cat.trim() || null) : null });
    setName(''); setFeet(''); setInch(''); setYards('');
  };

  const leader = groups[0]?.entries[0];

  return (
    <div style={{ marginTop: 6 }}>
      {c.category_mode !== 'open' && isLD && (
        <p style={{ fontSize: 11, color: '#8A9089', margin: '0 0 6px' }}>Split by {c.category_mode === 'by_gender' ? 'gender' : 'age'}</p>
      )}
      {groups.every((g) => g.entries.length === 0) ? (
        <p style={{ fontSize: 12.5, color: '#8A9089', margin: '4px 0' }}>No entries yet — add the first measurement below.</p>
      ) : groups.map((g) => (
        <div key={g.category} style={{ marginBottom: 8 }}>
          {(isLD && c.category_mode !== 'open') && <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', margin: '4px 0 2px' }}>{g.category}</p>}
          {g.entries.slice(0, 5).map((e) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <span style={{ width: 20, textAlign: 'right', color: e.rank === 1 ? 'var(--gold)' : '#8A9089', fontFamily: "'Fraunces', serif", fontWeight: 600 }}>{e.rank}</span>
              <span style={{ flex: 1, color: 'var(--ink)' }}>{e.player_name}</span>
              <span style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{e.raw_label || formatMeasurement(e.value_inches, c.contest_type)}</span>
              <button onClick={() => onRemoveEntry(e.id)} style={S.iconGhost}>✕</button>
            </div>
          ))}
        </div>
      ))}

      <form onSubmit={submit} style={{ display: 'grid', gap: 6, marginTop: 6, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
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
        <button onClick={() => onPatch({ id: c.id, winnerName: leader.player_name, winnerDetail: leader.raw_label || formatMeasurement(leader.value_inches, c.contest_type) })}
          style={{ ...S.miniBtn, ...S.miniBtnOn, marginTop: 6, width: '100%' }}>
          Record leader as winner ({leader.player_name})
        </button>
      )}
    </div>
  );
}

// ── Putting: paid add-on, pot, top-3 payout ──
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

  const saveWinners = () => {
    const winners = [w1, w2, w3].map((n, i) => ({ name: n.trim(), detail: payout[i] ? dollarsFromCents(payout[i].cents) : '', place: i + 1 })).filter((w) => w.name);
    onPatch({ id: c.id, winners });
  };

  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
      {c.entry_fee_cents != null && <Row label="Entry fee" value={`${dollarsFromCents(c.entry_fee_cents)} add-on`} />}
      <Row label="Add-ons sold" value={fieldSize ? `${entrants} of ${fieldSize}` : `${entrants}`} />
      <Row label="Pot" value={dollarsFromCents(pot)} />
      {payout.length > 0 && (
        <div style={{ background: '#F7F4EC', borderRadius: 8, padding: 8, marginTop: 4 }}>
          {payout.map((p) => (
            <div key={p.place} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ color: '#6B7775' }}>{['1st', '2nd', '3rd', '4th', '5th'][p.place - 1] ?? `${p.place}th`} · {p.pct}%</span>
              <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{dollarsFromCents(p.cents)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 6, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
        <span style={{ color: '#8A9089', fontWeight: 600, fontSize: 12.5 }}>Entrants ({entrants})</span>
        {c.entries.slice(0, 6).map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12.5 }}>
            <span style={{ flex: 1, color: 'var(--ink)' }}>{e.player_name}</span>
            <button onClick={() => onRemoveEntry(e.id)} style={S.iconGhost}>✕</button>
          </div>
        ))}
        {c.entries.length > 6 && <p style={{ fontSize: 11, color: '#8A9089', margin: '2px 0 0' }}>+{c.entries.length - 6} more</p>}
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onAddEntry({ contestHoleId: c.id, playerName: name.trim() }); setName(''); } }} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add entrant…" style={S.input} />
          <button type="submit" style={S.miniBtn}>Add</button>
        </form>
      </div>

      <div style={{ marginTop: 6, borderTop: '1px dashed var(--line)', paddingTop: 8, display: 'grid', gap: 4 }}>
        <span style={{ color: '#8A9089', fontWeight: 600, fontSize: 12.5 }}>Top 3 (splits the pot)</span>
        <input value={w1} onChange={(e) => setW1(e.target.value)} placeholder={`1st${payout[0] ? ` · ${dollarsFromCents(payout[0].cents)}` : ''}`} style={S.input} />
        <input value={w2} onChange={(e) => setW2(e.target.value)} placeholder={`2nd${payout[1] ? ` · ${dollarsFromCents(payout[1].cents)}` : ''}`} style={S.input} />
        <input value={w3} onChange={(e) => setW3(e.target.value)} placeholder={`3rd${payout[2] ? ` · ${dollarsFromCents(payout[2].cents)}` : ''}`} style={S.input} />
        <button onClick={saveWinners} style={{ ...S.miniBtn, ...S.miniBtnOn }}>Save winners</button>
      </div>
    </div>
  );
}

// ── Winners summary (ready for the awards ceremony) ──
function WinnersSummary({ contests }: { contests: Contest[] }) {
  const decided = contests.filter(isDecided);
  if (decided.length === 0) return null;
  return (
    <div style={{ marginTop: 28, background: 'var(--deep-green)', borderRadius: 16, padding: '22px 24px', color: '#fff' }}>
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--gold)', margin: '0 0 4px' }}>Ready for the awards ceremony</p>
      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, margin: '0 0 14px' }}>Contest winners</h3>
      <div style={{ display: 'grid', gap: 10 }}>
        {decided.map((c) => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid rgba(255,255,255,0.12)', paddingBottom: 8 }}>
            <span style={{ color: 'rgba(255,255,255,0.75)' }}>{CONTEST_META[c.contest_type].icon} {CONTEST_META[c.contest_type].label}{c.hole_number ? ` · Hole ${c.hole_number}` : ''}</span>
            <span style={{ textAlign: 'right', fontWeight: 600 }}>
              {c.contest_type === 'putting'
                ? c.winners.map((w) => `${w.place}. ${w.name}`).join('  ·  ')
                : `${c.winner_name}${c.winner_detail ? ` — ${c.winner_detail}` : ''}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Add-contest modal ──
function AddContestModal({ existing, onClose, onCreate }: {
  existing: Contest[];
  onClose: () => void;
  onCreate: (b: Record<string, unknown>) => Promise<string | null>;
}) {
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
  const dollarsToCents = (v: string) => { const n = Math.round(parseFloat(v) * 100); return Number.isFinite(n) && n >= 0 ? n : null; };

  const submit = async () => {
    setErr(''); setBusy(true);
    const body: Record<string, unknown> = { contestType: type, prize: prize || null, sponsor: sponsor || null, notes: notes || null };
    if (needsHole) body.holeNumber = Number(hole);
    if (type === 'hole_in_one') { body.prizeValueCents = dollarsToCents(prizeValue); body.insurer = insurer || null; body.insuranceCostCents = dollarsToCents(insuranceCost); }
    if (type === 'long_drive') body.categoryMode = categoryMode;
    if (type === 'putting') { body.locationLabel = locationLabel || null; body.entryFeeCents = dollarsToCents(entryFee); body.payoutSplit = payoutSplit || null; }
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
            <button key={t} onClick={() => setType(t)} style={{ ...S.typeBtn, ...(type === t ? S.typeBtnOn : {}) }}>
              <span style={{ fontSize: 18 }}>{CONTEST_META[t].icon}</span> {CONTEST_META[t].label}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          {needsHole && (
            <Field label="Hole number (1–18)">
              <input value={hole} onChange={(e) => setHole(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 12" style={S.input} />
            </Field>
          )}
          {type === 'putting' && (
            <Field label="Location / timing"><input value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} style={S.input} /></Field>
          )}
          <Field label="Prize"><input value={prize} onChange={(e) => setPrize(e.target.value)} placeholder="e.g. Pro shop $250 gift card" style={S.input} /></Field>
          <Field label="Sponsor (optional)"><input value={sponsor} onChange={(e) => setSponsor(e.target.value)} placeholder="e.g. Lambert & Co. CPAs" style={S.input} /></Field>
          <Field label="Notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Marker on each tee, witnessed by group" style={S.input} /></Field>

          {type === 'hole_in_one' && (
            <>
              <Field label="Prize retail value"><MoneyInput value={prizeValue} onChange={setPrizeValue} placeholder="8400" /></Field>
              <Field label="Insurer (optional)"><input value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="e.g. Northshore Toyota via HIO Inc." style={S.input} /></Field>
              <Field label="Insurance cost"><MoneyInput value={insuranceCost} onChange={setInsuranceCost} placeholder="475" /></Field>
            </>
          )}
          {type === 'long_drive' && (
            <Field label="Leaderboard split">
              <div style={{ display: 'flex', gap: 6 }}>
                {(['open', 'by_gender', 'by_age'] as const).map((m) => (
                  <button key={m} onClick={() => setCategoryMode(m)} style={{ ...S.miniBtn, ...(categoryMode === m ? S.miniBtnOn : {}) }}>
                    {m === 'open' ? 'Overall' : m === 'by_gender' ? 'By gender' : 'By age'}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {type === 'putting' && (
            <>
              <Field label="Entry fee (add-on)"><MoneyInput value={entryFee} onChange={setEntryFee} placeholder="10" /></Field>
              <Field label="Payout split"><input value={payoutSplit} onChange={(e) => setPayoutSplit(e.target.value)} placeholder="60/30/10" style={S.input} /></Field>
            </>
          )}
        </div>

        {err && <p style={{ color: 'var(--alert)', fontSize: 13, marginTop: 12 }}>{err}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={S.ghostBtn}>Cancel</button>
          <button onClick={submit} disabled={busy || (needsHole && !hole)} style={{ ...S.primaryBtn, opacity: busy || (needsHole && !hole) ? 0.5 : 1 }}>
            {busy ? 'Adding…' : 'Add contest'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}
function MoneyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>$</span>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder={placeholder} style={S.input} />
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  primaryBtn: { background: 'linear-gradient(180deg, var(--primary), var(--deep-green))', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 16px', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 18 },
  cardDecided: { borderColor: 'var(--primary)', boxShadow: '0 0 0 1px var(--primary) inset' },
  iconBox: { width: 40, height: 40, borderRadius: 10, background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  iconGhost: { background: 'none', border: 'none', color: '#B7BDB6', cursor: 'pointer', fontSize: 13, padding: 2, lineHeight: 1 },
  pill: { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px' },
  miniBtn: { background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' },
  miniBtnOn: { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' },
  check: { width: 22, height: 22, borderRadius: 6, border: '1.5px solid #B9C4BC', background: '#fff', color: '#fff', cursor: 'pointer', fontSize: 12, lineHeight: 1 },
  checkOn: { background: 'var(--primary)', borderColor: 'var(--primary)' },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'var(--ink)', background: '#fff', outline: 'none', boxSizing: 'border-box' },
  decidedTag: { marginTop: 12, background: '#EAF2ED', color: 'var(--primary)', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontWeight: 600 },
  empty: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 28, display: 'grid', gap: 12, justifyItems: 'start' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,30,20,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', zIndex: 50, overflowY: 'auto' },
  modal: { background: 'var(--cream)', borderRadius: 18, padding: 24, width: '100%', maxWidth: 460 },
  typeBtn: { display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px', fontSize: 13, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' },
  typeBtnOn: { background: 'var(--deep-green)', borderColor: 'var(--deep-green)', color: '#fff' },
};
