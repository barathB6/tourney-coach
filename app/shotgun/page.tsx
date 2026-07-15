'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { STANDARD_PAR_72, slotsForHole, courseCapacityTeams, findConflicts, autoAssign, type Team, type ShotgunFormat } from '@/lib/shotgun';

type Tournament = {
  id: string;
  name: string;
  location_name: string | null;
  shotgun_type: ShotgunFormat;
  shotgun_time: string | null;
  team_size: number;
  max_players: number;
  hole_pars: number[] | null;
};

// One "team" = one foursome_number group of registrations. Singles who joined
// a team share the group's foursome_number, so moving the group moves them all.
type RegRow = {
  id: string;
  registration_type: string;
  team_name: string | null;
  contact_name: string;
  foursome_number: number | null;
  starting_hole: number | null;
  start_slot: 'A' | 'B' | null;
  payment_status: string;
};

// Same labels as the tournament setup wizard (SetupClient.tsx) — the wizard is
// where the start method is chosen; this page just reflects (and can adjust)
// that saved choice.
const FORMAT_LABELS: Record<ShotgunFormat, string> = {
  double: 'Double Shotgun',
  single: 'Single Shotgun',
  wave: 'Wave Start',
  tee_times: 'Tee Times',
};

export default function ShotgunPage() {
  const router = useRouter();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [regs, setRegs] = useState<RegRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dragTeam, setDragTeam] = useState<number | null>(null); // foursome_number
  const [editingFormat, setEditingFormat] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user;
      if (!user) { router.replace('/sign-in'); return; }

      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* */ }

      // select('*') so a not-yet-migrated database (no hole_pars column) still
      // loads — the page falls back to a standard par-72 layout in that case.
      let t: Tournament | null = null;
      if (selectedId) {
        const { data } = await supabase.from('tournaments').select('*').eq('organizer_id', user.id).eq('id', selectedId).maybeSingle();
        t = data;
      }
      if (!t) {
        const { data } = await supabase.from('tournaments').select('*').eq('organizer_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        t = data;
      }
      if (t) {
        setTournament(t);
        await loadRegs(t.id);
      }
      setLoading(false);
    });
  }, [router]);

  async function loadRegs(tid: string) {
    const { data, error: e } = await supabase
      .from('registrations')
      .select('id, registration_type, team_name, contact_name, foursome_number, starting_hole, start_slot, payment_status')
      .eq('tournament_id', tid)
      .in('payment_status', ['pending', 'paid'])
      .order('foursome_number', { ascending: true });
    if (e) {
      // Pre-migration fallback: load without start_slot (view-only until 022).
      const { data: fallback, error: e2 } = await supabase
        .from('registrations')
        .select('id, registration_type, team_name, contact_name, foursome_number, starting_hole, payment_status')
        .eq('tournament_id', tid)
        .in('payment_status', ['pending', 'paid'])
        .order('foursome_number', { ascending: true });
      if (e2) { setError(`Couldn't load registrations: ${e2.message}`); return; }
      setError('Run migration 022_shotgun_start in Supabase to enable saving assignments (start_slot column is missing).');
      setRegs((fallback ?? []).map(r => ({ ...r, start_slot: null })).filter(r => r.registration_type !== 'sponsor'));
      return;
    }
    setRegs((data ?? []).filter(r => r.registration_type !== 'sponsor'));
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const pars: number[] = tournament?.hole_pars && Array.isArray(tournament.hole_pars) && tournament.hole_pars.length === 18
    ? tournament.hole_pars
    : STANDARD_PAR_72;
  const format = (tournament?.shotgun_type ?? 'double') as ShotgunFormat;

  const teamGroups = new Map<number, RegRow[]>();
  for (const r of regs) {
    if (r.foursome_number == null) continue;
    teamGroups.set(r.foursome_number, [...(teamGroups.get(r.foursome_number) ?? []), r]);
  }
  const teams: (Team & { foursomeNumber: number })[] = [...teamGroups.entries()].map(([n, rows]) => ({
    id: String(n),
    foursomeNumber: n,
    name: rows.find(r => r.team_name)?.team_name ?? rows[0].contact_name ?? `Foursome ${n}`,
    startingHole: rows[0].starting_hole,
    startSlot: rows[0].start_slot,
  }));

  const capacity = courseCapacityTeams(pars, format);
  const teamSize = tournament?.team_size ?? 4;
  const conflicts = findConflicts(teams, pars, format);
  const overCapacity = capacity != null && teams.length > capacity;
  const assignedCount = teams.filter(t => t.startingHole != null).length;
  const unassigned = teams.filter(t => t.startingHole == null);

  function teamAt(hole: number, slot: 'A' | 'B') {
    return teams.find(t => t.startingHole === hole && (t.startSlot ?? 'A') === slot);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  async function persistTeam(foursomeNumber: number, hole: number | null, slot: 'A' | 'B' | null) {
    if (!tournament) return;
    setSaving(true);
    setError('');
    const { error: e } = await supabase
      .from('registrations')
      .update({ starting_hole: hole, start_slot: slot })
      .eq('tournament_id', tournament.id)
      .eq('foursome_number', foursomeNumber);
    setSaving(false);
    if (e) { setError(`Couldn't save assignment: ${e.message} — make sure migration 022 has been run.`); return; }
    setRegs(prev => prev.map(r => r.foursome_number === foursomeNumber ? { ...r, starting_hole: hole, start_slot: slot } : r));
  }

  function handleDrop(hole: number, slot: 'A' | 'B') {
    if (dragTeam == null) return;
    const occupant = teamAt(hole, slot);
    if (occupant && occupant.foursomeNumber !== dragTeam) {
      setError(`Hole ${hole} slot ${slot} already has ${occupant.name} — move them first.`);
      setDragTeam(null);
      return;
    }
    persistTeam(dragTeam, hole, slot);
    setDragTeam(null);
  }

  async function handleAutoBalance() {
    const placed = autoAssign(teams, pars, format);
    for (const t of placed) {
      const before = teams.find(x => x.id === t.id)!;
      if (before.startingHole !== t.startingHole || before.startSlot !== t.startSlot) {
        await persistTeam((t as Team & { foursomeNumber: number }).foursomeNumber ?? Number(t.id), t.startingHole, t.startSlot);
      }
    }
  }

  async function setFormat(next: ShotgunFormat) {
    if (!tournament) return;
    const { error: e } = await supabase.from('tournaments').update({ shotgun_type: next }).eq('id', tournament.id);
    if (e) { setError(`Couldn't change format: ${e.message}`); return; }
    setTournament({ ...tournament, shotgun_type: next });
  }

  // Click the par chip to cycle 3 → 4 → 5 → 3. Conflicts (e.g. a B group left
  // on a hole that just became a par 3) surface in the banner rather than
  // being silently deleted — the organizer decides who moves.
  async function cyclePar(holeIdx: number) {
    if (!tournament) return;
    const next = [...pars];
    next[holeIdx] = pars[holeIdx] === 3 ? 4 : pars[holeIdx] === 4 ? 5 : 3;
    const { error: e } = await supabase.from('tournaments').update({ hole_pars: next }).eq('id', tournament.id);
    if (e) { setError(`Couldn't update hole par: ${e.message} — make sure migration 022 has been run.`); return; }
    setTournament({ ...tournament, hole_pars: next });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 12, padding: 20 },
    statLabel: { fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775', marginBottom: 4 },
    statValue: { fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700 },
    btn: { background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    btnGhost: { background: '#fff', color: '#1A1F1C', border: '1px solid #E5E0D5', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    chip: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'grab', display: 'flex', alignItems: 'center', gap: 6 },
  };

  if (loading) return <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><p style={{ color: '#6B7775' }}>Loading…</p></div>;
  if (!tournament) return <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><p style={{ color: '#6B7775' }}>Set up a tournament first.</p></div>;

  const holeBound = format === 'single' || format === 'double';

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>← Back to dashboard</button>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Shotgun Start Manager</h1>
        <p style={{ color: '#6B7775', margin: '4px 0 24px', fontSize: 14 }}>
          {tournament.name} · Par 3s take one foursome, par 4/5s take two (A tees off first, B follows)
        </p>

        {/* ── Format + stats bar ── */}
        <div className="tc-scroll-x" style={{ ...s.card, display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          {/* The start method comes from the tournament setup wizard — show it,
              don't ask for it again. "Change" writes back to the same field so
              the wizard and this page stay in sync. */}
          <div style={{ minWidth: 190 }}>
            <div style={s.statLabel}>Format · from event setup</div>
            {!editingFormat ? (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <div style={{ ...s.statValue, fontSize: 19 }}>
                  {FORMAT_LABELS[format]}{tournament.shotgun_time ? ` · ${tournament.shotgun_time}` : ''}
                </div>
                <button onClick={() => setEditingFormat(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 12, fontWeight: 600, padding: 0, fontFamily: 'inherit' }}>
                  Change
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {(['double', 'single', 'wave', 'tee_times'] as ShotgunFormat[]).map(f => (
                  <button key={f} onClick={() => { setFormat(f); setEditingFormat(false); }} style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 16, border: format === f ? '1px solid #1B6B3A' : '1px solid #E5E0D5', background: format === f ? '#1B6B3A' : '#fff', color: format === f ? '#fff' : '#6B7775', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                    {FORMAT_LABELS[f]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <div style={s.statLabel}>Field</div>
            <div style={s.statValue}>{teams.length}{capacity != null ? ` / ${capacity}` : ''} <span style={{ fontSize: 14, fontWeight: 400, color: '#6B7775' }}>teams</span></div>
          </div>
          <div>
            <div style={s.statLabel}>Players</div>
            <div style={s.statValue}>{teams.length * teamSize}{capacity != null ? ` / ${capacity * teamSize}` : ''}</div>
          </div>
          {capacity != null && (
            <div>
              <div style={s.statLabel}>Capacity remaining</div>
              <div style={{ ...s.statValue, color: overCapacity ? '#C0392B' : '#1B6B3A' }}>
                {overCapacity ? `${teams.length - capacity} over` : `${capacity - teams.length} teams`}
              </div>
            </div>
          )}
          {holeBound && (
            <button style={{ ...s.btn, marginLeft: 'auto' }} disabled={saving} onClick={handleAutoBalance}>
              {saving ? 'Saving…' : 'Auto-balance'}
            </button>
          )}
        </div>

        {/* ── Warnings ── */}
        {(error || overCapacity || conflicts.length > 0) && (
          <div style={{ background: '#FBE9E7', border: '1px solid #E7C3BA', borderRadius: 10, padding: '12px 16px', marginBottom: 14 }}>
            {error && <div style={{ fontSize: 13, color: '#C0392B', fontWeight: 600 }}>{error}</div>}
            {overCapacity && (
              <div style={{ fontSize: 13, color: '#C0392B' }}>
                Your field ({teams.length} teams) exceeds this course&rsquo;s {FORMAT_LABELS[format].toLowerCase()} capacity of {capacity} — {teams.length - capacity!} team{teams.length - capacity! === 1 ? '' : 's'} won&rsquo;t have a starting hole.
              </div>
            )}
            {conflicts.map((c, i) => <div key={i} style={{ fontSize: 13, color: '#C0392B' }}>{c.message}</div>)}
          </div>
        )}

        {!holeBound ? (
          <div style={{ ...s.card, textAlign: 'center', padding: '40px 24px' }}>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 19, marginBottom: 8 }}>{FORMAT_LABELS[format]} — no hole assignments needed</p>
            <p style={{ color: '#6B7775', fontSize: 14, maxWidth: 520, margin: '0 auto' }}>
              {format === 'wave'
                ? 'Groups tee off hole 1 in waves every 8–10 minutes, so the field isn’t bounded by hole capacity.'
                : 'Groups go off at standard tee-time intervals — best for smaller fields, and not bounded by hole capacity.'}
              {' '}Switch to a single or double shotgun to assign starting holes.
            </p>
          </div>
        ) : (
          <>
            {/* ── Unassigned tray ── */}
            <div
              style={{ ...s.card, marginBottom: 14, borderStyle: unassigned.length ? 'dashed' : 'solid' }}
              onDragOver={e => e.preventDefault()}
              onDrop={() => { if (dragTeam != null) persistTeam(dragTeam, null, null); setDragTeam(null); }}
            >
              <div style={{ ...s.statLabel, marginBottom: 8 }}>Unassigned teams ({unassigned.length}) — drag onto a hole, or drop here to unassign</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {unassigned.length === 0 && <span style={{ fontSize: 13, color: '#9BA8A4' }}>{teams.length === 0 ? 'No paid or pending foursomes yet.' : 'Every team has a starting hole. 🎉'}</span>}
                {unassigned.map(t => (
                  <div key={t.id} draggable style={s.chip} onDragStart={() => setDragTeam(t.foursomeNumber)}>
                    ⠿ {t.name}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Hole grid ── */}
            <div style={{ ...s.card, padding: 24 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>
                Hole assignments{tournament.location_name ? ` — ${tournament.location_name}` : ''}
              </h2>
              <p style={{ color: '#6B7775', fontSize: 13, margin: '0 0 18px' }}>
                Drag teams between holes. Click a hole&rsquo;s par to change it (3 → 4 → 5) — capacity recalculates instantly.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                {pars.map((par, i) => {
                  const hole = i + 1;
                  const slots = slotsForHole(par, format);
                  const holeConflict = conflicts.some(c => c.hole === hole);
                  return (
                    <div key={hole} style={{
                      border: holeConflict ? '2px solid #C0392B' : '1px solid #E5E0D5',
                      background: par === 3 ? '#EDF2FA' : '#F0F6F1',
                      borderRadius: 10, padding: '14px 12px', textAlign: 'center',
                    }}>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700 }}>{hole}</div>
                      <button onClick={() => cyclePar(i)} title="Click to change par" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', color: '#6B7775', background: 'none', border: '1px dashed transparent', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 8 }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = '#9BA8A4')}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'transparent')}>
                        PAR {par}
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {slots.map(slot => {
                          const occ = teamAt(hole, slot);
                          return (
                            <div
                              key={slot}
                              onDragOver={e => e.preventDefault()}
                              onDrop={() => handleDrop(hole, slot)}
                              style={{
                                background: '#fff', border: occ ? '1px solid #E5E0D5' : '1px dashed #C9D3CC',
                                borderRadius: 7, padding: '7px 8px', fontSize: 12, fontWeight: occ ? 600 : 400,
                                color: occ ? '#1A1F1C' : '#9BA8A4', minHeight: 32,
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                                cursor: occ ? 'grab' : 'default',
                              }}
                              draggable={!!occ}
                              onDragStart={() => occ && setDragTeam(occ.foursomeNumber)}
                            >
                              {occ ? (
                                <>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {format === 'double' && par !== 3 ? `${slot} · ` : ''}{occ.name}
                                  </span>
                                  <button onClick={() => persistTeam(occ.foursomeNumber, null, null)} title="Unassign" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9BA8A4', padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
                                </>
                              ) : (format === 'double' && par !== 3 ? `${slot} · open` : 'Open')}
                            </div>
                          );
                        })}
                        {/* Orphaned B team on a par 3 renders here so it stays visible + draggable */}
                        {par === 3 && teams.filter(t => t.startingHole === hole && t.startSlot === 'B').map(t => (
                          <div key={t.id} draggable onDragStart={() => setDragTeam(t.foursomeNumber)} style={{ background: '#FBE9E7', border: '1px solid #C0392B', borderRadius: 7, padding: '7px 8px', fontSize: 12, fontWeight: 600, color: '#C0392B', cursor: 'grab' }}>
                            B · {t.name} — move me
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Legend */}
              <div style={{ display: 'flex', gap: 18, marginTop: 18, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6B7775' }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: '#EDF2FA', border: '1px solid #C9D3E5' }} /> Par 3 · single team
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6B7775' }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: '#F0F6F1', border: '1px solid #C9E0CE' }} /> Par 4 / Par 5 · double-stack
                </span>
                <span style={{ fontSize: 12, color: '#6B7775' }}>{assignedCount} of {teams.length} teams placed</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
