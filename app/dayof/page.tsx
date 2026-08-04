'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';

// The organizer's day-of operations dashboard. One screen, held in one hand,
// while standing in the clubhouse: who has arrived, where they are, what is
// overdue, who needs help, and the buttons that tell the right people the
// field has moved.
//
// Sorting is deliberate — overdue first, then by role. An organizer scans this
// for problems, not for a roster.

type Position = {
  assignmentId: string; volunteerId: string; name: string; phone: string | null;
  roleName: string; status: string; checkedInAt: string | null;
  position: string | null; positionAt: string | null;
  tasksTotal: number; tasksDone: number; overdue: number;
};
type Trigger = {
  kind: string; label: string; hint: string; roles: string[];
  firedAt: string | null; firedBy: string | null; notified: number;
};
type DayOf = {
  tournamentName: string; eventDate: string | null; shotgunTime: string | null;
  positions: Position[]; triggers: Trigger[];
  escalations: { id: string; volunteerId: string; name: string; audience: string; body: string; escalated: boolean; createdAt: string }[];
  summary: { expected: number; checkedIn: number; tasksDone: number; tasksTotal: number; overdue: number; openEscalations: number };
  fireError?: string;
  fired?: { kind: string; notified: number; failed: number };
};

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';

export default function DayOfPage() {
  const router = useRouter();
  const [tid, setTid] = useState<string | null>(null);
  const [d, setD] = useState<DayOf | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (id: string) => {
    const res = await authedFetch(`/api/tournament/${id}/dayof`);
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setD(j as DayOf); setError(''); }
    else setError(j.error || 'Could not load the day-of view');
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/dayof'); return; }
      let selected: string | null = null;
      try { selected = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const { data: all } = await supabase.from('tournaments').select('id, name')
        .eq('organizer_id', user.id).order('created_at', { ascending: false });
      const t = (all ?? []).find((x) => x.id === selected) ?? (all ?? [])[0] ?? null;
      if (!t) { setLoading(false); return; }
      setTid(t.id);
      await load(t.id);
      setLoading(false);
    });
  }, [router, load]);

  // On the day this screen is left open on a laptop behind the check-in table.
  // It has to keep itself current without anybody remembering to refresh.
  useEffect(() => {
    if (!tid) return;
    const iv = setInterval(() => load(tid), 30_000);
    return () => clearInterval(iv);
  }, [tid, load]);

  async function act(body: Record<string, unknown>) {
    if (!tid || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tid}/dayof`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(j.error || 'That did not work'); return; }
    setD(j as DayOf);
    if (j.fireError) setError(j.fireError);
    else if (j.fired) setNote(`${j.fired.notified} volunteer${j.fired.notified === 1 ? '' : 's'} notified${j.fired.failed ? `, ${j.fired.failed} could not be reached` : ''}.`);
  }

  if (loading) return <main style={S.wrap}><p style={{ color: '#8A9089' }}>Loading…</p></main>;
  if (!tid || !d) return <main style={S.wrap}><p>Create a tournament first.</p></main>;

  const s = d.summary;
  return (
    <main style={S.wrap}>
      <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>
      <header style={{ margin: '12px 0 16px' }}>
        <p style={S.kick}>Day-of operations · {d.tournamentName}</p>
        <h1 style={{ fontSize: 28, margin: '4px 0 0', fontFamily: "'Fraunces', serif" }}>Live board</h1>
      </header>

      {note && <p style={S.note}>{note}</p>}
      {error && <p style={S.err}>{error}</p>}

      <section style={{ ...S.card, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          <Stat label="Checked in" value={`${s.checkedIn}/${s.expected}`} accent={s.checkedIn < s.expected ? 'var(--gold)' : undefined} />
          <Stat label="Tasks done" value={`${s.tasksDone}/${s.tasksTotal}`} />
          <Stat label="Overdue" value={String(s.overdue)} accent={s.overdue ? 'var(--alert)' : undefined} />
          <Stat label="Needs help" value={String(s.openEscalations)} accent={s.openEscalations ? 'var(--alert)' : undefined} />
        </div>
      </section>

      {/* ── Escalation queue: the only thing that outranks everything else ── */}
      {d.escalations.length > 0 && (
        <section style={{ ...S.card, marginBottom: 14, borderColor: 'var(--alert)' }}>
          <p style={S.kick}>Needs you now</p>
          {d.escalations.map((e) => (
            <div key={e.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <strong style={{ fontSize: 14.5 }}>{e.name}</strong>
              {e.escalated && <span style={{ ...S.pill, color: '#B8442C', background: '#FBE9E7', marginLeft: 8 }}>escalated to platform</span>}
              <p style={{ margin: '4px 0 8px', fontSize: 14, lineHeight: 1.55 }}>{e.body}</p>
              <button style={S.mini} disabled={busy} onClick={() => act({ action: 'resolve', messageId: e.id })}>
                Mark handled
              </button>
            </div>
          ))}
        </section>
      )}

      {/* ── Event-driven triggers ─────────────────────────────────────────── */}
      <section style={{ ...S.card, marginBottom: 14 }}>
        <p style={S.kick}>Tell the crew where the field is</p>
        <p style={{ fontSize: 13, color: '#5C6B62', margin: '4px 0 12px', lineHeight: 1.55 }}>
          Each one goes to just the roles that need it, once. A clock cannot know the field is
          forty minutes behind — you can.
        </p>
        {d.triggers.map((t) => (
          <div key={t.kind} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 180 }}>
              <strong style={{ fontSize: 14.5, display: 'block' }}>{t.label}</strong>
              <span style={{ fontSize: 12.5, color: '#8A9089', lineHeight: 1.5 }}>
                {t.firedAt
                  ? `Sent ${time(t.firedAt)} to ${t.notified} volunteer${t.notified === 1 ? '' : 's'}`
                  : t.hint}
              </span>
            </span>
            {t.firedAt ? (
              <span style={{ ...S.pill, color: '#1B6B3A', background: '#E7F1EA' }}>Sent</span>
            ) : (
              <button style={S.btn} disabled={busy} onClick={() => act({ action: 'fire', kind: t.kind })}>Send</button>
            )}
          </div>
        ))}
      </section>

      {/* ── Live positions ────────────────────────────────────────────────── */}
      <section style={S.card}>
        <p style={S.kick}>Where everyone is</p>
        {d.positions.length === 0 && (
          <p style={{ fontSize: 14, color: '#8A9089', margin: '8px 0 0' }}>
            No day-of roles assigned yet. Build the crew on Your Team.
          </p>
        )}
        {d.positions.map((p) => (
          <div key={p.assignmentId} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '11px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 190 }}>
              <strong style={{ fontSize: 14.5 }}>{p.roleName}</strong>
              <span style={{ color: '#8A9089', fontSize: 13 }}> · {p.name}</span>
              <span style={{ display: 'block', fontSize: 12.5, color: '#5C6B62', marginTop: 2 }}>
                {p.checkedInAt ? `In at ${time(p.checkedInAt)}` : 'Not checked in'}
                {p.position ? ` · at ${p.position} (${time(p.positionAt)})` : ''}
                {p.tasksTotal > 0 ? ` · ${p.tasksDone}/${p.tasksTotal} tasks` : ''}
              </span>
            </span>
            {p.overdue > 0 && <span style={{ ...S.pill, color: '#B8442C', background: '#FBE9E7' }}>{p.overdue} overdue</span>}
            {!p.checkedInAt && p.status === 'confirmed' && (
              <button style={S.mini} disabled={busy} onClick={() => act({ action: 'check_in', volunteerId: p.volunteerId })}>
                Check in
              </button>
            )}
            {p.phone && <a href={`tel:${p.phone}`} style={S.miniLink}>Call</a>}
          </div>
        ))}
      </section>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p style={{ fontSize: 24, fontWeight: 700, margin: 0, fontFamily: "'Fraunces', serif", color: accent ?? 'var(--ink)' }}>{value}</p>
      <p style={{ fontSize: 12, color: '#8A9089', margin: 0 }}>{label}</p>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: '0 auto', padding: '24px 18px 70px' },
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: 18 },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089', margin: 0 },
  pill: { fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  mini: { background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)', whiteSpace: 'nowrap' },
  miniLink: { background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: 'var(--primary)', textDecoration: 'none', whiteSpace: 'nowrap' },
  note: { background: '#E7F1EA', color: '#1B6B3A', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, margin: '0 0 12px' },
  err: { background: '#FBE9E7', color: '#B8442C', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, margin: '0 0 12px' },
};
