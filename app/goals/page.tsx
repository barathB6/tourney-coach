'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';

type Goal = {
  key: 'players' | 'sponsorship' | 'donations' | 'marketing' | 'volunteers';
  label: string;
  target: number | null;
  actual: number;
  unit: 'count' | 'cents';
  percent: number | null;
  met: boolean;
};
type Snapshot = {
  tournament: { id: string; name: string; eventDate: string | null };
  goals: Goal[];
  counts: { planningRoles: number; dayOfRoles: number; rolesFilled: number; tasksOverdue: number; tasksDueSoon: number };
};

// What each goal actually depends on, so a number at 0% points somewhere.
const SOURCE: Record<Goal['key'], { note: string; href?: string; cta?: string }> = {
  players:     { note: 'Counts paid registrations — a foursome is 4, a single is 1. Sponsor packages are money, not players.', href: '/dashboard/registrations', cta: 'Registrations' },
  sponsorship: { note: 'Counts sponsors marked verbal, invoiced or paid. Cold prospects do not count until someone says yes.', href: '/sponsors', cta: 'Sponsorships' },
  donations:   { note: 'Counts items a vendor has actually committed. A prospect you have only contacted — or who said no — does not move this.', href: '/fb', cta: 'Vendor donations' },
  marketing:   { note: 'Counts messages actually delivered, once each. A failed send does not count, and the in-app copy of an email is not a second message.', href: '/team', cta: 'Communication' },
  volunteers:  { note: 'Counts distinct roles with at least one volunteer who has not declined.' },
};

const fmt = (v: number, unit: Goal['unit']) =>
  unit === 'cents' ? `$${(v / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : v.toLocaleString();

// The input works in dollars; the API takes dollars and stores cents.
const toInput = (g: Goal) => (g.target == null ? '' : String(g.unit === 'cents' ? g.target / 100 : g.target));

export default function GoalsPage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (tid: string) => {
    const res = await authedFetch(`/api/tournament/${tid}/toc`);
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setSnap(d as Snapshot); setError(''); }
    else setError(d.error || 'Could not load goals');
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/goals'); return; }
      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const { data: all } = await supabase.from('tournaments').select('id, name')
        .eq('organizer_id', user.id).order('created_at', { ascending: false });
      const list = all ?? [];
      const t = list.find((x) => x.id === selectedId) ?? list[0] ?? null;
      if (!t) { setLoading(false); return; }
      setTournamentId(t.id);
      await load(t.id);
      setLoading(false);
    });
  }, [router, load]);

  function startEditing() {
    if (!snap) return;
    setDraft(Object.fromEntries(snap.goals.map((g) => [g.key, toInput(g)])));
    setEditing(true);
  }

  async function save() {
    if (!tournamentId) return;
    setSaving(true); setError('');
    const int = (v: string) => { const n = Number(v); return v.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null; };
    const res = await authedFetch(`/api/tournament/${tournamentId}/toc`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerGoal: int(draft.players ?? ''),
        sponsorshipGoalDollars: int(draft.sponsorship ?? ''),
        donationItemsGoal: int(draft.donations ?? ''),
        marketingReachGoal: int(draft.marketing ?? ''),
        volunteerRolesGoal: int(draft.volunteers ?? ''),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(d.error || 'Could not save'); return; }
    setSnap(d as Snapshot);
    setEditing(false);
  }

  const set = snap?.goals.filter((g) => g.target != null) ?? [];
  const met = set.filter((g) => g.met).length;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '26px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

        <div style={{ margin: '14px 0 22px' }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 38, lineHeight: 1.05, color: 'var(--ink)', margin: '0 0 10px' }}>Tournament Goals</h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.5, color: '#5C6B62', maxWidth: 660, margin: 0 }}>
            The five numbers your committee is actually judged on. Progress is read live from your registrations, sponsors and volunteers — there is nothing to keep updated.
          </p>
        </div>

        {loading ? (
          <p style={{ color: '#8A9089' }}>Loading…</p>
        ) : !tournamentId ? (
          <div style={S.card}><p style={{ margin: 0, color: '#6B7775' }}>Set up your event first, then you can set goals for it.</p></div>
        ) : !snap ? (
          <div style={{ ...S.card, borderColor: '#F5C6C0' }}><p style={{ margin: 0, color: 'var(--alert)' }}>{error || 'Could not load goals.'}</p></div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 14, color: '#5C6B62' }}>
                {snap.tournament.name}
                {set.length > 0 && <> · <strong style={{ color: met === set.length ? 'var(--primary)' : 'var(--ink)' }}>{met} of {set.length}</strong> goals met</>}
              </p>
              {!editing && (
                <button onClick={startEditing} style={S.btn}>{set.length ? 'Edit goals' : 'Set your goals'}</button>
              )}
            </div>

            {error && <div style={{ ...S.card, borderColor: '#F5C6C0', marginBottom: 16 }}><p style={{ margin: 0, color: 'var(--alert)', fontSize: 13.5 }}>{error}</p></div>}

            {set.length === 0 && !editing && (
              <div style={{ ...S.card, background: '#F3EFE4', marginBottom: 18 }}>
                <p style={{ margin: 0, fontSize: 13.5, color: '#4A524C', lineHeight: 1.6 }}>
                  No goals set yet. Your live numbers are below either way — setting a target just gives them something to measure against. A first-year event commonly aims for a full field, half the raise from sponsorship, and every day-of role filled.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {snap.goals.map((g) => {
                const src = SOURCE[g.key];
                return (
                  <div key={g.key} style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 700 }}>{g.label}</div>
                      {editing ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, color: '#8A9089' }}>target{g.unit === 'cents' ? ' ($)' : ''}</span>
                          <input
                            type="number" min={0} inputMode="numeric"
                            value={draft[g.key] ?? ''}
                            onChange={(e) => setDraft((d) => ({ ...d, [g.key]: e.target.value }))}
                            placeholder="none"
                            style={{ width: 120, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 14, textAlign: 'right', fontFamily: 'inherit' }}
                          />
                        </div>
                      ) : (
                        <div style={{ fontSize: 14, color: '#5C6B62' }}>
                          <strong style={{ color: 'var(--ink)', fontSize: 17 }}>{fmt(g.actual, g.unit)}</strong>
                          {g.target != null && <> of {fmt(g.target, g.unit)}</>}
                          {g.met && <span style={{ marginLeft: 8, background: '#E7F1EA', color: 'var(--primary)', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>Met</span>}
                        </div>
                      )}
                    </div>

                    {!editing && (
                      <div style={{ marginTop: 12, height: 10, background: '#F1ECDD', borderRadius: 5, overflow: 'hidden' }}>
                        <div style={{
                          width: `${g.percent ?? 0}%`, height: '100%', borderRadius: 5,
                          background: g.met ? 'var(--primary)' : g.percent != null && g.percent >= 50 ? '#7FAE8C' : 'var(--gold)',
                          transition: 'width .3s',
                        }} />
                      </div>
                    )}

                    <p style={{ margin: '10px 0 0', fontSize: 12.5, color: '#8A9089', lineHeight: 1.5 }}>
                      {g.target == null && !editing ? 'No target set — showing your live number only. ' : ''}
                      {src.note}
                      {src.href && (
                        <> <button onClick={() => router.push(src.href!)} style={S.link}>{src.cta} →</button></>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>

            {editing && (
              <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
                <button onClick={save} disabled={saving} style={{ ...S.btn, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save goals'}</button>
                <button onClick={() => setEditing(false)} style={S.btnGhost}>Cancel</button>
                <span style={{ fontSize: 12.5, color: '#8A9089' }}>Leave a field blank to track that number without a target.</span>
              </div>
            )}

            <div style={{ ...S.card, marginTop: 18, background: '#F3EFE4' }}>
              <div style={S.kick}>Volunteer roles</div>
              <p style={{ margin: '6px 0 0', fontSize: 13.5, color: '#4A524C', lineHeight: 1.6 }}>
                {snap.counts.rolesFilled} of {snap.counts.planningRoles + snap.counts.dayOfRoles} roles have someone in them
                {' '}({snap.counts.planningRoles} planning, {snap.counts.dayOfRoles} day-of).
                {snap.counts.tasksOverdue > 0 && <> <strong style={{ color: 'var(--alert)' }}>{snap.counts.tasksOverdue} task{snap.counts.tasksOverdue === 1 ? '' : 's'} overdue.</strong></>}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 20 },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnGhost: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  link: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
};
