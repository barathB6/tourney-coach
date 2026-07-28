'use client';

import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import HoleSchematic from '@/components/gps/HoleSchematic';
import { HOLE_SHAPE_TAGS, HOLE_SHAPE_TAG_LABELS, describeShapeTags, emptyHoles, type CourseHole } from '@/lib/course';

type Registration = {
  id: string;
  registration_type: string;
  team_name: string | null;
  contact_name: string;
  contact_email: string;
  total_amount_cents: number;
  payment_status: string;
  foursome_number: number | null;
  starting_hole: number | null;
  created_at: string;
};

const TYPE_LABELS: Record<string, string> = {
  foursome: 'Foursome',
  single: 'Single',
  sponsor: 'Sponsor',
};

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  paid: { bg: '#EAF2ED', color: '#1B6B3A', label: 'Paid' },
  pending: { bg: '#FDF8EC', color: '#8A6D00', label: 'Pending' },
  failed: { bg: '#FEF2F2', color: '#B91C1C', label: 'Failed' },
  refunded: { bg: '#EFF1F0', color: '#5C6B62', label: 'Refunded' },
};

function fmtMoney(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

type TournamentOption = { id: string; name: string; course_id: string | null };

export default function RegistrationsPage() {
  const router = useRouter();
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingTournament, setDeletingTournament] = useState(false);
  const [error, setError] = useState('');

  // Manual (paper) registration form
  const [showAdd, setShowAdd] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addForm, setAddForm] = useState({
    type: 'single', contactName: '', contactEmail: '', contactPhone: '',
    teamName: '', playerNames: ['', '', '', ''], markPaid: true,
  });

  const [userId, setUserId] = useState<string | null>(null);

  // Organizer score correction (per team). Opening a row reveals hole/strokes/
  // reason inputs; submitting appends a corrected score + writes an audit row.
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correctForm, setCorrectForm] = useState({ hole: '1', strokes: '4', reason: '' });
  const [correctSaving, setCorrectSaving] = useState(false);
  const [correctMsg, setCorrectMsg] = useState('');

  // Hole map: chip-select the layout/feature tags for each hole of the
  // selected tournament's course, right from the Registrations tab — the
  // Course Builder edits the same course_holes rows.
  const [holes, setHoles] = useState<CourseHole[]>(emptyHoles());
  const [holesCourseId, setHolesCourseId] = useState<string | null>(null);
  const [selectedHole, setSelectedHole] = useState(1);
  const [holeSaveNote, setHoleSaveNote] = useState('');

  async function submitCorrection(reg: Registration) {
    setCorrectSaving(true);
    setCorrectMsg('');
    try {
      const res = await authedFetch('/api/scores/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registrationId: reg.id,
          holeNumber: Number(correctForm.hole),
          strokes: Number(correctForm.strokes),
          reason: correctForm.reason.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Correction failed');
      const from = data.previousStrokes != null ? `${data.previousStrokes} → ` : '';
      const capNote = data.capped ? ' (capped by max-score rule)' : '';
      const auditNote = data.auditLogged ? '' : ' — audit table missing, run migration 028';
      setCorrectMsg(`Hole ${correctForm.hole} corrected: ${from}${data.strokesRecorded}${capNote}.${auditNote}`);
    } catch (e) {
      setCorrectMsg(e instanceof Error ? e.message : 'Correction failed');
    } finally {
      setCorrectSaving(false);
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (!user) { router.replace('/sign-in'); return; }
      setUserId(user.id);

      const { data } = await supabase
        .from('tournaments')
        .select('id, name, course_id')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false });

      const list = data ?? [];
      setTournaments(list);

      // Resume whichever tournament was last picked here (also shown on the
      // dashboard's top bar), falling back to the newest if it's gone.
      let saved: string | null = null;
      try { saved = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const stillExists = saved && list.some(t => t.id === saved);

      if (list.length > 0) setSelectedTournament(stillExists ? saved! : list[0].id);
      else setLoading(false);
    });
  }, [router]);

  function selectTournament(id: string) {
    setSelectedTournament(id);
    if (userId) {
      try { localStorage.setItem(`tourney_selected_tournament_${userId}`, id); } catch { /* ignore */ }
    }
  }

  useEffect(() => {
    if (!selectedTournament) return;
    let cancelled = false;

    const fetchRegs = async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      const { data } = await supabase
        .from('registrations')
        .select('id, registration_type, team_name, contact_name, contact_email, total_amount_cents, payment_status, foursome_number, starting_hole, created_at')
        .eq('tournament_id', selectedTournament)
        .order('created_at', { ascending: false });
      if (!cancelled) {
        setRegistrations(data ?? []);
        setLoading(false);
      }
    };

    fetchRegs(true);
    // Poll every 10s so new registrations appear without a manual refresh
    const interval = setInterval(() => fetchRegs(false), 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedTournament]);

  const courseId = tournaments.find(t => t.id === selectedTournament)?.course_id ?? null;
  const holesLoading = !!courseId && holesCourseId !== courseId;

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    supabase.from('course_holes').select('*').eq('course_id', courseId).order('hole_number').then(({ data }) => {
      if (cancelled) return;
      const next = emptyHoles();
      for (const row of data ?? []) {
        next[row.hole_number - 1] = { holeNumber: row.hole_number, par: row.par, handicap: row.handicap, description: row.description, shapeTags: row.shape_tags ?? [], teeYardages: row.tee_yardages ?? {} };
      }
      setHoles(next);
      setSelectedHole(1);
      setHolesCourseId(courseId);
    });
    return () => { cancelled = true; };
  }, [courseId]);

  async function toggleShapeTag(tag: string) {
    if (!courseId) return;
    const hole = holes[selectedHole - 1];
    const shapeTags = hole.shapeTags.includes(tag) ? hole.shapeTags.filter(t => t !== tag) : [...hole.shapeTags, tag];
    const next = { ...hole, shapeTags, description: describeShapeTags(shapeTags) };
    setHoles(prev => prev.map(h => (h.holeNumber === next.holeNumber ? next : h)));
    await supabase.from('course_holes').upsert(
      { course_id: courseId, hole_number: next.holeNumber, par: next.par, handicap: next.handicap, description: next.description, shape_tags: next.shapeTags, tee_yardages: next.teeYardages },
      { onConflict: 'course_id,hole_number' },
    );
    setHoleSaveNote('Saved'); setTimeout(() => setHoleSaveNote(''), 1200);
  }

  async function handleManualAdd(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const playerCount = addForm.type === 'single' ? 1 : 4;
    const names = [addForm.contactName, ...addForm.playerNames].map(n => n.trim()).filter(Boolean);
    const players = (addForm.type === 'single' ? [addForm.contactName] : names.slice(0, 4))
      .map(n => ({ name: n, email: '' }));

    if (players.length !== playerCount) {
      setError(`Enter ${playerCount} player name${playerCount > 1 ? 's' : ''} (contact counts as player 1).`);
      return;
    }

    setAddSaving(true);
    try {
      const res = await authedFetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament_id: selectedTournament,
          registration_type: addForm.type,
          team_name: addForm.teamName.trim() || null,
          contact_name: addForm.contactName.trim(),
          contact_email: addForm.contactEmail.trim(),
          contact_phone: addForm.contactPhone.trim() || null,
          players,
          add_ons: [],
          registration_source: 'other',
          manual: true,
          mark_paid: addForm.markPaid,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add registration');

      setShowAdd(false);
      setAddForm({ type: 'single', contactName: '', contactEmail: '', contactPhone: '', teamName: '', playerNames: ['', '', '', ''], markPaid: true });
      // Refresh list immediately
      const { data: regs } = await supabase
        .from('registrations')
        .select('id, registration_type, team_name, contact_name, contact_email, total_amount_cents, payment_status, foursome_number, starting_hole, created_at')
        .eq('tournament_id', selectedTournament)
        .order('created_at', { ascending: false });
      setRegistrations(regs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add registration');
    } finally {
      setAddSaving(false);
    }
  }

  async function handleRefund(reg: Registration) {
    if (!window.confirm(`Refund ${fmtMoney(reg.total_amount_cents)} to ${reg.contact_name}? This cannot be undone.`)) return;

    setRefunding(reg.id);
    setError('');
    try {
      const res = await authedFetch('/api/payments/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_id: reg.id, reason: 'Organizer-initiated refund' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refund failed');

      // Optimistically show refund in progress; webhook flips status to refunded
      setRegistrations(prev => prev.map(r => r.id === reg.id ? { ...r, payment_status: 'refunded' } : r));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setRefunding(null);
    }
  }

  async function handleDelete(reg: Registration) {
    if (!window.confirm(`Delete this registration for ${reg.contact_name}? This cannot be undone.`)) return;

    setDeleting(reg.id);
    setError('');
    try {
      const res = await authedFetch(`/api/registrations/${reg.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete registration');

      setRegistrations(prev => prev.filter(r => r.id !== reg.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete registration');
    } finally {
      setDeleting(null);
    }
  }

  async function handleDeleteTournament() {
    const t = tournaments.find(t => t.id === selectedTournament);
    if (!t) return;
    if (!window.confirm(`Delete "${t.name}" entirely? This removes the tournament and all its registrations. This cannot be undone.`)) return;

    setDeletingTournament(true);
    setError('');
    try {
      const res = await authedFetch(`/api/tournaments/${selectedTournament}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete tournament');

      const remaining = tournaments.filter(x => x.id !== selectedTournament);
      setTournaments(remaining);
      if (remaining[0]) selectTournament(remaining[0].id);
      else setSelectedTournament('');
      if (remaining.length === 0) setRegistrations([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tournament');
    } finally {
      setDeletingTournament(false);
    }
  }

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 8, overflow: 'hidden' },
  };

  if (loading) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  const paidTotal = registrations.filter(r => r.payment_status === 'paid').reduce((sum, r) => sum + r.total_amount_cents, 0);

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        <div style={{ marginBottom: 32 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
            ← Back to dashboard
          </button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Registrations</h1>
            <button
              onClick={() => setShowAdd(v => !v)}
              style={{ background: showAdd ? 'none' : '#1B4425', color: showAdd ? '#1B6B3A' : '#fff', border: showAdd ? '1px solid #E5E0D5' : 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans', sans-serif" }}
            >
              {showAdd ? 'Cancel' : '+ Add registration'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 0' }}>
            {tournaments.length > 1 ? (
              <select
                value={selectedTournament}
                onChange={e => selectTournament(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 13.5, fontFamily: "'DM Sans', sans-serif", color: '#1A1F1C', background: '#fff', cursor: 'pointer' }}
              >
                {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <span style={{ color: '#6B7775', fontSize: 14 }}>{tournaments[0]?.name}</span>
            )}
            <span style={{ color: '#6B7775', fontSize: 14 }}>
              {registrations.length} {registrations.length === 1 ? 'registration' : 'registrations'} · {fmtMoney(paidTotal)} collected
            </span>
            {selectedTournament && (
              <button
                onClick={handleDeleteTournament}
                disabled={deletingTournament}
                style={{ marginLeft: 'auto', background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '5px 11px', cursor: deletingTournament ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 600, color: '#B91C1C', fontFamily: "'DM Sans', sans-serif", opacity: deletingTournament ? 0.6 : 1 }}
              >
                {deletingTournament ? 'Deleting…' : 'Delete this tournament'}
              </button>
            )}
          </div>
        </div>

        {selectedTournament && (
          <div style={{ ...s.card, padding: '20px 24px', marginBottom: 20 }}>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 17, fontWeight: 600, margin: '0 0 4px' }}>Hole map</p>
            {!courseId ? (
              <p style={{ color: '#6B7775', fontSize: 13.5, margin: 0 }}>
                This tournament has no course profile yet. <Link href={`/course/new?tournament=${selectedTournament}`} style={{ color: '#1B6B3A', fontWeight: 600 }}>Set one up</Link> to start tagging hole layouts.
              </p>
            ) : holesLoading ? (
              <p style={{ color: '#6B7775', fontSize: 13.5, margin: 0 }}>Loading…</p>
            ) : (
              <>
                <p style={{ color: '#6B7775', fontSize: 13, margin: '0 0 14px' }}>Tag each hole&apos;s layout and features — the hole map players see is generated from these chips.</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
                  {holes.map((h) => (
                    <button
                      key={h.holeNumber}
                      onClick={() => setSelectedHole(h.holeNumber)}
                      style={{
                        width: 34, height: 34, borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit',
                        border: selectedHole === h.holeNumber ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                        background: selectedHole === h.holeNumber ? '#1B6B3A' : h.shapeTags.length ? '#E7F1EA' : '#fff',
                        color: selectedHole === h.holeNumber ? '#fff' : '#1A1F1C',
                      }}
                    >
                      {h.holeNumber}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }} className="tc-two-col">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#6B7775', textTransform: 'uppercase' }}>Hole {selectedHole} — layout &amp; shape</label>
                      {holeSaveNote && <span style={{ fontSize: 12, color: '#1B6B3A', fontWeight: 600 }}>{holeSaveNote}</span>}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {HOLE_SHAPE_TAGS.map((tag) => {
                        const active = holes[selectedHole - 1].shapeTags.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleShapeTag(tag)}
                            style={{
                              borderRadius: 20, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                              border: active ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                              background: active ? '#E7F1EA' : '#fff', color: active ? '#1B6B3A' : '#1A1F1C',
                            }}
                          >
                            {HOLE_SHAPE_TAG_LABELS[tag]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <HoleSchematic hole={holes[selectedHole - 1]} maxWidth={220} />
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#B91C1C', marginBottom: 16 }}>
            {error}
          </div>
        )}

        {showAdd && (
          <form onSubmit={handleManualAdd} style={{ ...s.card, padding: '20px 24px', marginBottom: 20 }}>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 17, fontWeight: 600, margin: '0 0 4px' }}>Add paper registration</p>
            <p style={{ color: '#6B7775', fontSize: 13, margin: '0 0 16px' }}>For sign-ups collected in person, by phone, or by check.</p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Type</label>
                <select
                  value={addForm.type}
                  onChange={e => setAddForm(f => ({ ...f, type: e.target.value }))}
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14, fontFamily: "'DM Sans', sans-serif", background: '#fff', boxSizing: 'border-box' }}
                >
                  <option value="single">Single — $165</option>
                  <option value="foursome">Foursome — $600</option>
                  <option value="sponsor">Sponsor + Foursome — $5,000</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Team name (optional)</label>
                <input
                  value={addForm.teamName}
                  onChange={e => setAddForm(f => ({ ...f, teamName: e.target.value }))}
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
            </div>

            <div className="tc-quick" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Contact name *</label>
                <input
                  required
                  value={addForm.contactName}
                  onChange={e => setAddForm(f => ({ ...f, contactName: e.target.value }))}
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Email *</label>
                <input
                  required
                  type="email"
                  value={addForm.contactEmail}
                  onChange={e => setAddForm(f => ({ ...f, contactEmail: e.target.value }))}
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Phone</label>
                <input
                  value={addForm.contactPhone}
                  onChange={e => setAddForm(f => ({ ...f, contactPhone: e.target.value }))}
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
            </div>

            {addForm.type !== 'single' && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Players 2–4 (contact is player 1)</label>
                <div className="tc-quick" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {[0, 1, 2].map(i => (
                    <input
                      key={i}
                      placeholder={`Player ${i + 2} name`}
                      value={addForm.playerNames[i]}
                      onChange={e => setAddForm(f => {
                        const names = [...f.playerNames];
                        names[i] = e.target.value;
                        return { ...f, playerNames: names };
                      })}
                      style={{ width: '100%', padding: '9px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                    />
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={addForm.markPaid}
                  onChange={e => setAddForm(f => ({ ...f, markPaid: e.target.checked }))}
                  style={{ accentColor: '#1B6B3A' }}
                />
                Mark as paid (cash / check received)
              </label>
              <button
                type="submit"
                disabled={addSaving}
                style={{ background: '#1B4425', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: addSaving ? 'not-allowed' : 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", opacity: addSaving ? 0.6 : 1 }}
              >
                {addSaving ? 'Saving…' : 'Save registration'}
              </button>
            </div>
          </form>
        )}

        {registrations.length === 0 ? (
          <div style={{ ...s.card, padding: '48px 32px', textAlign: 'center' }}>
            <p style={{ fontSize: 32, marginBottom: 12 }}>⛳</p>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 8 }}>No registrations yet</p>
            <p style={{ color: '#6B7775', fontSize: 14 }}>Share your microsite registration link to start filling foursomes.</p>
          </div>
        ) : (
          <div className="tc-scroll-x" style={s.card}>
            <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E0D5', background: '#FAF8F3' }}>
                  {['Contact', 'Type', 'Team', 'Foursome', 'Amount', 'Status', ''].map(h => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {registrations.map((r, i) => {
                  const st = STATUS_STYLES[r.payment_status] ?? STATUS_STYLES.pending;
                  return (
                    <React.Fragment key={r.id}>
                    <tr style={{ borderBottom: i < registrations.length - 1 ? '1px solid #E5E0D5' : 'none' }}>
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{r.contact_name}</div>
                        <a href={`mailto:${r.contact_email}`} style={{ color: '#1B6B3A', textDecoration: 'none', fontSize: 12.5 }}>{r.contact_email}</a>
                      </td>
                      <td style={{ padding: '14px 16px', fontSize: 14 }}>{TYPE_LABELS[r.registration_type] ?? r.registration_type}</td>
                      <td style={{ padding: '14px 16px', fontSize: 14, color: r.team_name ? '#1A1F1C' : '#9BA8A4' }}>{r.team_name ?? '—'}</td>
                      <td style={{ padding: '14px 16px', fontSize: 14 }}>
                        {r.foursome_number ? `#${r.foursome_number}` : '—'}
                        {r.starting_hole ? <span style={{ color: '#6B7775', fontSize: 12.5 }}> · Hole {r.starting_hole}</span> : null}
                      </td>
                      <td style={{ padding: '14px 16px', fontSize: 14, fontWeight: 600 }}>{fmtMoney(r.total_amount_cents)}</td>
                      <td style={{ padding: '14px 16px' }}>
                        <span style={{ background: st.bg, color: st.color, borderRadius: 999, padding: '3px 10px', fontWeight: 600, fontSize: 12.5 }}>
                          {st.label}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <a
                          href={`/live/${r.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open this player's Live Round view — the GPS hole map"
                          style={{ background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, color: '#1B6B3A', textDecoration: 'none', fontFamily: "'DM Sans', sans-serif", marginRight: 8, display: 'inline-block' }}
                        >
                          Live map ↗
                        </a>
                        {r.registration_type !== 'sponsor' && (
                          <button
                            onClick={() => { setCorrecting(correcting === r.id ? null : r.id); setCorrectMsg(''); }}
                            title="Correct this team's score for a hole (audit-logged)"
                            style={{ background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#1A1F1C', fontFamily: "'DM Sans', sans-serif", marginRight: 8 }}
                          >
                            {correcting === r.id ? 'Close' : 'Fix score'}
                          </button>
                        )}
                        {r.payment_status === 'paid' && (
                          <button
                            onClick={() => handleRefund(r)}
                            disabled={refunding === r.id}
                            style={{ background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '6px 12px', cursor: refunding === r.id ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 600, color: '#B8442C', fontFamily: "'DM Sans', sans-serif", opacity: refunding === r.id ? 0.6 : 1, marginRight: 8 }}
                          >
                            {refunding === r.id ? 'Refunding…' : 'Refund'}
                          </button>
                        )}
                        {r.payment_status !== 'paid' && (
                          <button
                            onClick={() => handleDelete(r)}
                            disabled={deleting === r.id}
                            title="Delete registration"
                            style={{ background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '6px 12px', cursor: deleting === r.id ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 600, color: '#6B7775', fontFamily: "'DM Sans', sans-serif", opacity: deleting === r.id ? 0.6 : 1 }}
                          >
                            {deleting === r.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {correcting === r.id && (
                      <tr key={`${r.id}-correct`}>
                        <td colSpan={7} style={{ padding: '14px 16px', background: '#FAF8F3', borderBottom: '1px solid #E5E0D5' }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
                            <label style={{ fontSize: 12, color: '#6B7775', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              Hole
                              <select value={correctForm.hole} onChange={e => setCorrectForm(f => ({ ...f, hole: e.target.value }))} style={{ padding: '8px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14 }}>
                                {Array.from({ length: 18 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                              </select>
                            </label>
                            <label style={{ fontSize: 12, color: '#6B7775', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              Strokes
                              <input type="number" min={1} max={20} value={correctForm.strokes} onChange={e => setCorrectForm(f => ({ ...f, strokes: e.target.value }))} style={{ width: 70, padding: '8px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14 }} />
                            </label>
                            <label style={{ fontSize: 12, color: '#6B7775', display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' }}>
                              Reason (optional)
                              <input value={correctForm.reason} onChange={e => setCorrectForm(f => ({ ...f, reason: e.target.value }))} placeholder="e.g. scorer typo" style={{ padding: '8px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 14 }} />
                            </label>
                            <button
                              onClick={() => submitCorrection(r)}
                              disabled={correctSaving}
                              style={{ background: '#1B4425', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', cursor: correctSaving ? 'not-allowed' : 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", opacity: correctSaving ? 0.6 : 1 }}
                            >
                              {correctSaving ? 'Saving…' : 'Apply correction'}
                            </button>
                          </div>
                          {correctMsg && <p style={{ margin: '10px 0 0', fontSize: 13, color: correctMsg.includes('corrected') ? '#1B6B3A' : '#B91C1C' }}>{correctMsg}</p>}
                          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: '#9AA39D' }}>Appends a corrected score (history is preserved) and records who changed it in the audit log.</p>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
