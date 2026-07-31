'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';

type Member = {
  assignmentId: string; volunteerId: string; name: string; email: string | null; phone: string | null;
  roleId: string; roleName: string; phase: 'planning' | 'day_of'; status: string;
  invitedAt: string | null; respondedAt: string | null; inviteChannel: string | null; inviteError: string | null;
  startsAt: string | null; remindersSent: number[];
  checkedInAt: string | null; noShow: boolean;
};
type Role = {
  id: string; name: string; description: string | null; phase: 'planning' | 'day_of';
  sortOrder: number; taskTitles: string[]; earliestOffsetHours: number | null; members: Member[];
};
type Team = {
  tournament: { id: string; name: string; eventDate: string | null };
  roles: Role[];
  summary: { planningFilled: number; planningTotal: number; dayOfFilled: number; dayOfTotal: number; awaitingResponse: number; declined: number; noShows: number };
};

const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  assigned:  { label: 'Awaiting reply', fg: '#8A6D1F', bg: '#FBF0DC' },
  confirmed: { label: 'Confirmed',      fg: '#1B6B3A', bg: '#E7F1EA' },
  declined:  { label: 'Declined',       fg: '#B8442C', bg: '#FBE9E7' },
  completed: { label: 'Done',           fg: '#5C6B62', bg: '#EFEAE0' },
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : null;

export default function TeamPage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [phase, setPhase] = useState<'planning' | 'day_of'>('planning');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (tid: string) => {
    const res = await authedFetch(`/api/tournament/${tid}/team`);
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setTeam(d as Team); setError(''); } else setError(d.error || 'Could not load your team');
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/team'); return; }
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

  async function assign(roleId: string) {
    if (!tournamentId || busy) return;
    setBusy(true); setNote(''); setError('');
    const res = await authedFetch(`/api/tournament/${tournamentId}/team`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleTemplateId: roleId, ...draft }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'Could not assign that role'); return; }
    setTeam(d as Team);
    setDraft({ name: '', email: '', phone: '' });
    setOpenRole(null);
    const inv = d.invite as { ok: boolean; channels: string[]; error?: string } | null;
    setNote(inv?.ok ? `Invitation sent by ${inv.channels.join(' and ')}.`
      : inv?.error ? `Assigned, but the invitation did not send — ${inv.error}` : 'Assigned.');
  }

  async function act(assignmentId: string, payload: Record<string, unknown>) {
    if (!tournamentId || busy) return;
    setBusy(true); setNote(''); setError('');
    const res = await authedFetch(`/api/tournament/${tournamentId}/team`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignmentId, ...payload }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'That did not work'); return; }
    setTeam(d as Team);
    const inv = d.invite as { ok: boolean; channels: string[]; error?: string } | null;
    if (inv) setNote(inv.ok ? `Invitation re-sent by ${inv.channels.join(' and ')}.` : `Could not send — ${inv.error}`);
  }

  const roles = (team?.roles ?? []).filter((r) => r.phase === phase);
  const s = team?.summary;
  const filled = phase === 'planning' ? s?.planningFilled : s?.dayOfFilled;
  const total = phase === 'planning' ? s?.planningTotal : s?.dayOfTotal;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '26px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

        <div style={{ margin: '14px 0 20px' }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 38, lineHeight: 1.05, color: 'var(--ink)', margin: '0 0 10px' }}>Your Team</h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.5, color: '#5C6B62', maxWidth: 680, margin: 0 }}>
            Two teams, two clocks. The planning committee is recruited 12–16 weeks out; the day-of crew 4–8 weeks out. Everyone gets the role, what it involves, and a link to say yes or no — no account needed.
          </p>
        </div>

        {loading ? (
          <p style={{ color: '#8A9089' }}>Loading…</p>
        ) : !tournamentId ? (
          <div style={S.card}><p style={{ margin: 0, color: '#6B7775' }}>Set up your event first.</p></div>
        ) : !team ? (
          <div style={{ ...S.card, borderColor: '#F5C6C0' }}><p style={{ margin: 0, color: 'var(--alert)' }}>{error || 'Could not load your team.'}</p></div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {(['planning', 'day_of'] as const).map((p) => {
                const on = phase === p;
                const f = p === 'planning' ? s!.planningFilled : s!.dayOfFilled;
                const tt = p === 'planning' ? s!.planningTotal : s!.dayOfTotal;
                return (
                  <button key={p} onClick={() => setPhase(p)} style={{
                    borderRadius: 999, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                    border: on ? '1px solid var(--primary)' : '1px solid var(--line)',
                    background: on ? 'var(--primary)' : '#fff', color: on ? '#fff' : 'var(--ink)',
                  }}>
                    {p === 'planning' ? 'Planning team' : 'Day-of team'} · {f}/{tt}
                  </button>
                );
              })}
            </div>

            <div style={{ ...S.card, marginBottom: 16, display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
              <Stat label="Roles filled" value={`${filled} of ${total}`} />
              <Stat label="Awaiting reply" value={String(s!.awaitingResponse)} accent={s!.awaitingResponse ? 'var(--gold)' : undefined} />
              <Stat label="Declined" value={String(s!.declined)} accent={s!.declined ? 'var(--alert)' : undefined} />
              <Stat label="No-shows" value={String(s!.noShows)} accent={s!.noShows ? 'var(--alert)' : undefined} />
            </div>

            {note && <div style={{ ...S.card, marginBottom: 14, background: '#E7F1EA', borderColor: '#B7E0C6' }}><p style={{ margin: 0, fontSize: 13.5, color: 'var(--deep-green)' }}>{note}</p></div>}
            {error && <div style={{ ...S.card, marginBottom: 14, borderColor: '#F5C6C0' }}><p style={{ margin: 0, fontSize: 13.5, color: 'var(--alert)' }}>{error}</p></div>}

            {s!.noShows > 0 && (
              <div style={{ ...S.card, marginBottom: 14, background: '#FBE9E7', borderColor: '#F5C6C0' }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--alert)' }}>No-show alert</div>
                <p style={{ margin: '6px 0 0', fontSize: 14, color: '#7A2E1E', lineHeight: 1.6 }}>
                  {s!.noShows} confirmed volunteer{s!.noShows === 1 ? ' has' : 's have'} not checked in and their role has already started.
                  {' '}Find them below and either check them in or move somebody across.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {roles.map((r) => {
                const open = openRole === r.id;
                const active = r.members.filter((m) => m.status !== 'declined');
                return (
                  <div key={r.id} style={{ ...S.card, borderColor: active.length ? '#B7E0C6' : 'var(--line)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 320px' }}>
                        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 700 }}>{r.name}</div>
                        {r.description && <p style={{ margin: '4px 0 0', fontSize: 13.5, color: '#5C6B62', lineHeight: 1.5 }}>{r.description}</p>}
                        {r.taskTitles.length > 0 && (
                          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: '#8A9089' }}>
                            {r.taskTitles.length} task{r.taskTitles.length === 1 ? '' : 's'}: {r.taskTitles.slice(0, 3).join(' · ')}{r.taskTitles.length > 3 ? ' …' : ''}
                          </p>
                        )}
                      </div>
                      <button onClick={() => { setOpenRole(open ? null : r.id); setDraft({ name: '', email: '', phone: '' }); }} style={open ? S.btnGhost : S.btn}>
                        {open ? 'Cancel' : active.length ? 'Add another' : 'Assign someone'}
                      </button>
                    </div>

                    {r.members.length > 0 && (
                      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {r.members.map((m) => {
                          const st = STATUS[m.status] ?? STATUS.assigned;
                          return (
                            <div key={m.assignmentId} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', background: '#FAF8F3', borderRadius: 10, border: '1px solid var(--line)' }}>
                              <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                              <span style={{ background: st.bg, color: st.fg, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>{st.label}</span>
                              {m.noShow && <span style={{ background: '#FBE9E7', color: 'var(--alert)', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>No-show</span>}
                              {m.checkedInAt && <span style={{ background: '#E7F1EA', color: 'var(--primary)', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>Checked in</span>}
                              <span style={{ fontSize: 12, color: '#8A9089', flex: 1, minWidth: 140 }}>
                                {m.invitedAt ? `Invited ${m.inviteChannel ? `by ${m.inviteChannel}` : ''}` : 'Not invited yet'}
                                {m.remindersSent.length > 0 && ` · ${m.remindersSent.length} reminder${m.remindersSent.length === 1 ? '' : 's'} sent`}
                              </span>
                              {m.phase === 'day_of' && (
                                <button onClick={() => act(m.assignmentId, { action: m.checkedInAt ? 'undo_checkin' : 'checkin' })} disabled={busy} style={S.mini}>
                                  {m.checkedInAt ? 'Undo check-in' : 'Check in'}
                                </button>
                              )}
                              <button onClick={() => act(m.assignmentId, { action: 'resend' })} disabled={busy} style={S.mini}>Re-send</button>
                              {m.status !== 'confirmed' && (
                                <button onClick={() => act(m.assignmentId, { status: 'confirmed' })} disabled={busy} style={S.mini}>Mark confirmed</button>
                              )}
                              <button onClick={() => act(m.assignmentId, { action: 'remove' })} disabled={busy} style={{ ...S.mini, color: 'var(--alert)' }}>Remove</button>
                              {m.inviteError && <span style={{ width: '100%', fontSize: 12, color: 'var(--alert)' }}>Invite failed: {m.inviteError}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {open && (
                      <div style={{ marginTop: 12, padding: 14, background: '#FAF8F3', borderRadius: 10, border: '1px solid var(--line)' }}>
                        <div className="tc-quick" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                          <input placeholder="Full name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} style={S.input} />
                          <input placeholder="Email" type="email" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} style={S.input} />
                          <input placeholder="Phone (for texts)" value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} style={S.input} />
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                          <button onClick={() => assign(r.id)} disabled={busy} style={{ ...S.btn, opacity: busy ? 0.6 : 1 }}>
                            {busy ? 'Sending…' : 'Assign and invite'}
                          </button>
                          <span style={{ fontSize: 12.5, color: '#8A9089' }}>
                            They get the role, what it involves, and a link to accept. Add a phone and they get a text too, plus reminders 7 days, 2 days and 90 minutes before.
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' }}>{label}</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: accent ?? 'var(--ink)' }}>{value}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 20 },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  btnGhost: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  mini: { background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
};
