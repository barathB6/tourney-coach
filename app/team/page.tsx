'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';

type Member = {
  assignmentId: string; volunteerId: string; name: string; email: string | null; phone: string | null;
  roleId: string; roleName: string; phase: 'planning' | 'day_of'; status: string;
  invitedAt: string | null; respondedAt: string | null; inviteChannel: string | null; inviteError: string | null;
  inviteUrl: string | null;
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
  summary: {
    planningFilled: number; planningTotal: number; dayOfFilled: number; dayOfTotal: number;
    awaitingResponse: number; declined: number; noShows: number;
    planning: { awaiting: number; declined: number };
    dayOf: { awaiting: number; declined: number; noShows: number };
  };
};
type Meeting = {
  id: string; title: string; scheduledAt: string; agenda: string | null; notes: string | null;
  attendance: { volunteerId: string; name: string; status: string }[];
};
type ActionItem = {
  id: string; meetingId: string | null; description: string; ownerName: string | null;
  ownerVolunteerId: string | null; dueAt: string | null; completedAt: string | null;
};
type Meetings = {
  meetings: Meeting[]; actionItems: ActionItem[]; openItems: number; unownedItems: number;
  volunteers: { id: string; name: string }[];
};
type CommData = {
  threads: { volunteerId: string; name: string; unread: number; escalated: boolean;
    messages: { id: string; direction: string; audience: string; senderName: string | null; body: string; createdAt: string }[] }[];
  profiles: { volunteerId: string; name: string; experienceLevel: string; depth: string; cadence: string; channel: string; computedAt: string; recomputeReason: string | null }[];
  ledger: { id: string; volunteerName: string; channel: string; kind: string; subject: string | null; status: string; offsetKey: string | null; error: string | null; sentAt: string | null }[];
  unreadTotal: number;
};

// The pill vocabulary. "Need" is the important one — an unfilled role is not a
// neutral empty state, it is the thing the organizer has to go do something
// about, so it reads in the alert colour alongside the filled ones.
const PILL: Record<string, { label: string; fg: string; bg: string }> = {
  need:      { label: 'Need',      fg: '#B8442C', bg: '#FBE9E7' },
  assigned:  { label: 'Asked',     fg: '#8A6D1F', bg: '#FBF0DC' },
  confirmed: { label: 'Confirmed', fg: '#1B6B3A', bg: '#E7F1EA' },
  declined:  { label: 'Declined',  fg: '#B8442C', bg: '#FBE9E7' },
  completed: { label: 'Done',      fg: '#5C6B62', bg: '#EFEAE0' },
  noshow:    { label: 'No-show',   fg: '#B8442C', bg: '#FBE9E7' },
};

const dt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function TeamPage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [meetings, setMeetings] = useState<Meetings | null>(null);
  const [tab, setTab] = useState<'planning' | 'day_of' | 'meetings' | 'inbox'>('planning');
  const [comm, setComm] = useState<CommData | null>(null);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [mtgDraft, setMtgDraft] = useState({ title: '', scheduledAt: '', agenda: '' });
  const [itemDraft, setItemDraft] = useState<Record<string, string>>({});

  const load = useCallback(async (tid: string) => {
    const [tRes, mRes, cRes] = await Promise.all([
      authedFetch(`/api/tournament/${tid}/team`),
      authedFetch(`/api/tournament/${tid}/meetings`),
      authedFetch(`/api/tournament/${tid}/comm`),
    ]);
    const t = await tRes.json().catch(() => ({}));
    const m = await mRes.json().catch(() => ({}));
    const c = await cRes.json().catch(() => ({}));
    if (tRes.ok) { setTeam(t as Team); setError(''); } else setError(t.error || 'Could not load your team');
    if (mRes.ok) setMeetings(m as Meetings);
    if (cRes.ok) setComm(c as CommData);
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

  async function commAct(body: Record<string, unknown>) {
    if (!tournamentId || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tournamentId}/comm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'That did not work'); return; }
    setComm(d as CommData);
    if (d.run) setNote(`Reminder run: ${d.run.sent} sent, ${d.run.alreadyClaimed} already sent, ${d.run.failed} failed.`);
  }

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

  async function meetingCall(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
    if (!tournamentId || busy) return;
    setBusy(true); setError('');
    const res = await authedFetch(`/api/tournament/${tournamentId}/meetings`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'That did not work'); return; }
    setMeetings(d as Meetings);
  }

  const s = team?.summary;
  const roles = (team?.roles ?? []).filter((r) => r.phase === tab);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '26px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

        <div style={{ margin: '14px 0 20px' }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 36, lineHeight: 1.05, color: 'var(--ink)', margin: '0 0 10px' }}>Volunteer Command Center</h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.55, color: '#5C6B62', maxWidth: 680, margin: 0 }}>
            Role-based assignments with the task library built in. Text reminders go out 7 days, 2 days and 90 minutes before each role starts.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {['Twilio texts', 'Role library', 'No-show alerts'].map((c) => (
              <span key={c} style={S.chip}>{c}</span>
            ))}
          </div>
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
              <Tab on={tab === 'planning'} onClick={() => setTab('planning')} label={`Planning team · ${s!.planningFilled}/${s!.planningTotal}`} />
              <Tab on={tab === 'day_of'} onClick={() => setTab('day_of')} label={`Day-of team · ${s!.dayOfFilled}/${s!.dayOfTotal}`} />
              <Tab on={tab === 'meetings'} onClick={() => setTab('meetings')} label={`Meetings${meetings?.openItems ? ` · ${meetings.openItems} open` : ''}`} />
              <Tab on={tab === 'inbox'} onClick={() => setTab('inbox')} label={`Inbox${comm?.unreadTotal ? ` · ${comm.unreadTotal} new` : ''}`} />
            </div>

            {note && <Banner tone="good">{note}</Banner>}
            {error && <Banner tone="bad">{error}</Banner>}
            {s!.dayOf.noShows > 0 && tab === 'day_of' && (
              <Banner tone="bad">
                {s!.dayOf.noShows} confirmed volunteer{s!.dayOf.noShows === 1 ? ' has' : 's have'} not checked in and their role has already started. Check them in below, or move somebody across.
              </Banner>
            )}

            {tab === 'inbox' ? (
              <InboxView comm={comm} draft={replyDraft} setDraft={setReplyDraft} onAction={commAct} busy={busy} />
            ) : tab !== 'meetings' ? (
              <>
                <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 14, padding: '0 4px' }}>
                  <Stat label="Filled" value={`${tab === 'planning' ? s!.planningFilled : s!.dayOfFilled} of ${tab === 'planning' ? s!.planningTotal : s!.dayOfTotal}`} />
                  <Stat label="Awaiting reply" value={String(tab === 'planning' ? s!.planning.awaiting : s!.dayOf.awaiting)}
                    accent={(tab === 'planning' ? s!.planning.awaiting : s!.dayOf.awaiting) ? 'var(--gold)' : undefined} />
                  <Stat label="Declined" value={String(tab === 'planning' ? s!.planning.declined : s!.dayOf.declined)}
                    accent={(tab === 'planning' ? s!.planning.declined : s!.dayOf.declined) ? 'var(--alert)' : undefined} />
                  {tab === 'day_of' && <Stat label="No-shows" value={String(s!.dayOf.noShows)} accent={s!.dayOf.noShows ? 'var(--alert)' : undefined} />}
                </div>

                {/* The roster. One row per role — filled or not — because an
                    unfilled role is the most important thing on this screen and
                    hiding it behind an empty state loses it. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {roles.map((r) => {
                    const open = openRole === r.id;
                    const active = r.members.filter((m) => m.status !== 'declined');
                    const lead = active[0] ?? r.members[0] ?? null;
                    const pill = !lead ? PILL.need : lead.noShow ? PILL.noshow : (PILL[lead.status] ?? PILL.assigned);
                    const extra = active.length > 1 ? ` +${active.length - 1}` : '';
                    return (
                      <div key={r.id}>
                        <button
                          onClick={() => { setOpenRole(open ? null : r.id); setDraft({ name: '', email: '', phone: '' }); }}
                          style={{ ...S.row, borderColor: open ? 'var(--primary)' : 'var(--line)' }}
                        >
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0, flex: 1, textAlign: 'left' }}>
                            <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>{r.name}</span>
                            <span style={{ color: '#B0B8B2' }}>·</span>
                            <span style={{ fontSize: 14.5, color: lead ? '#4A524C' : '#9BA8A4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {lead ? `${lead.name}${extra}` : 'open'}
                            </span>
                          </span>
                          <span style={{ background: pill.bg, color: pill.fg, borderRadius: 999, padding: '5px 13px', fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {pill.label}
                          </span>
                        </button>

                        {open && (
                          <div style={S.panel}>
                            {r.description && <p style={{ margin: '0 0 10px', fontSize: 13.5, color: '#5C6B62', lineHeight: 1.55 }}>{r.description}</p>}
                            {r.taskTitles.length > 0 && (
                              <div style={{ marginBottom: 12 }}>
                                <div style={S.kick}>What this role does</div>
                                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13.5, color: '#4A524C', lineHeight: 1.7 }}>
                                  {r.taskTitles.map((t, i) => <li key={i}>{t}</li>)}
                                </ul>
                              </div>
                            )}

                            {r.members.map((m) => {
                              const mp = m.noShow ? PILL.noshow : (PILL[m.status] ?? PILL.assigned);
                              return (
                                <div key={m.assignmentId} style={S.memberRow}>
                                  <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                                  <span style={{ background: mp.bg, color: mp.fg, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>{mp.label}</span>
                                  {m.checkedInAt && <span style={{ background: '#E7F1EA', color: 'var(--primary)', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>Checked in</span>}
                                  <span style={{ fontSize: 12, color: '#8A9089', flex: 1, minWidth: 130 }}>
                                    {m.invitedAt ? `Invited${m.inviteChannel ? ` by ${m.inviteChannel}` : ''}` : 'Not invited yet'}
                                    {m.remindersSent.length > 0 && ` · ${m.remindersSent.length} reminder${m.remindersSent.length === 1 ? '' : 's'}`}
                                  </span>
                                  {m.phase === 'day_of' && (
                                    <button onClick={() => act(m.assignmentId, { action: m.checkedInAt ? 'undo_checkin' : 'checkin' })} disabled={busy} style={S.mini}>
                                      {m.checkedInAt ? 'Undo check-in' : 'Check in'}
                                    </button>
                                  )}
                                  <button onClick={() => act(m.assignmentId, { action: 'resend' })} disabled={busy} style={S.mini}>Re-send</button>
                                  {m.inviteUrl && (
                                    <button style={S.mini} onClick={() => { navigator.clipboard?.writeText(m.inviteUrl!); setNote(`Link copied — text or hand it to ${m.name.split(' ')[0]} any way you like.`); }}>
                                      Copy link
                                    </button>
                                  )}
                                  {m.status !== 'confirmed' && <button onClick={() => act(m.assignmentId, { status: 'confirmed' })} disabled={busy} style={S.mini}>Confirm</button>}
                                  <button onClick={() => act(m.assignmentId, { action: 'remove' })} disabled={busy} style={{ ...S.mini, color: 'var(--alert)' }}>Remove</button>
                                  {m.inviteError && (
                                    <span style={{ width: '100%', fontSize: 12, color: 'var(--alert)', lineHeight: 1.5 }}>
                                      Invite failed: {m.inviteError}
                                      {m.inviteUrl && <> — use <strong>Copy link</strong> above and send it yourself; the link works regardless.</>}
                                    </span>
                                  )}
                                </div>
                              );
                            })}

                            <div className="tc-quick" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: r.members.length ? 12 : 0 }}>
                              <input placeholder="Full name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} style={S.input} />
                              <input placeholder="Email" type="email" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} style={S.input} />
                              <input placeholder="Phone (for texts)" value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} style={S.input} />
                            </div>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                              <button onClick={() => assign(r.id)} disabled={busy} style={{ ...S.btn, opacity: busy ? 0.6 : 1 }}>
                                {busy ? 'Sending…' : 'Assign and invite'}
                              </button>
                              <span style={{ fontSize: 12.5, color: '#8A9089' }}>
                                They get the role, what it involves, and a link to accept — no account needed.
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <MeetingsView
                meetings={meetings}
                busy={busy}
                mtgDraft={mtgDraft}
                setMtgDraft={setMtgDraft}
                itemDraft={itemDraft}
                setItemDraft={setItemDraft}
                call={meetingCall}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MeetingsView({ meetings, busy, mtgDraft, setMtgDraft, itemDraft, setItemDraft, call }: {
  meetings: Meetings | null; busy: boolean;
  mtgDraft: { title: string; scheduledAt: string; agenda: string };
  setMtgDraft: React.Dispatch<React.SetStateAction<{ title: string; scheduledAt: string; agenda: string }>>;
  itemDraft: Record<string, string>;
  setItemDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  call: (m: 'POST' | 'PATCH', b: Record<string, unknown>) => Promise<void>;
}) {
  if (!meetings) return <div style={S.card}><p style={{ margin: 0, color: '#6B7775' }}>Loading meetings…</p></div>;

  // Open items lead, because carry-over is what a committee actually loses
  // track of between meetings.
  const open = meetings.actionItems.filter((i) => !i.completedAt);
  const done = meetings.actionItems.filter((i) => i.completedAt);

  return (
    <>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 14, padding: '0 4px' }}>
        <Stat label="Meetings" value={String(meetings.meetings.length)} />
        <Stat label="Open action items" value={String(meetings.openItems)} accent={meetings.openItems ? 'var(--gold)' : undefined} />
        <Stat label="Nobody owns" value={String(meetings.unownedItems)} accent={meetings.unownedItems ? 'var(--alert)' : undefined} />
      </div>

      {open.length > 0 && (
        <div style={{ ...S.card, marginBottom: 14 }}>
          <div style={S.kick}>Still open</div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {open.map((i) => (
              <div key={i.id} style={S.memberRow}>
                <span style={{ fontSize: 14, flex: 1, minWidth: 180 }}>{i.description}</span>
                <span style={{ fontSize: 12.5, color: i.ownerName ? '#5C6B62' : 'var(--alert)', fontWeight: i.ownerName ? 400 : 700 }}>
                  {i.ownerName ?? 'nobody owns this'}
                </span>
                <button onClick={() => call('PATCH', { kind: 'action_item', itemId: i.id })} disabled={busy} style={S.mini}>Mark done</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ ...S.card, marginBottom: 14 }}>
        <div style={S.kick}>Schedule a meeting</div>
        <div className="tc-quick" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <input placeholder="Title (e.g. Weekly planning meeting)" value={mtgDraft.title}
            onChange={(e) => setMtgDraft((d) => ({ ...d, title: e.target.value }))} style={S.input} />
          <input type="datetime-local" value={mtgDraft.scheduledAt}
            onChange={(e) => setMtgDraft((d) => ({ ...d, scheduledAt: e.target.value }))} style={S.input} />
        </div>
        <textarea placeholder="Agenda" rows={3} value={mtgDraft.agenda}
          onChange={(e) => setMtgDraft((d) => ({ ...d, agenda: e.target.value }))}
          style={{ ...S.input, marginTop: 10, resize: 'vertical' }} />
        <button
          onClick={async () => {
            // A datetime-local input yields a naked wall-clock string with no
            // zone ("2026-09-15T18:30"). Parsing that on the SERVER read it as
            // server time — UTC on Vercel — so a chair in Central booked 6:30pm
            // and the meeting came back as 1:30pm. The browser is the only place
            // that knows which 6:30 they meant, so it resolves the instant here.
            const localIso = new Date(mtgDraft.scheduledAt).toISOString();
            await call('POST', { title: mtgDraft.title, scheduledAt: localIso, agenda: mtgDraft.agenda });
            setMtgDraft({ title: '', scheduledAt: '', agenda: '' });
          }}
          disabled={busy || !mtgDraft.scheduledAt}
          style={{ ...S.btn, marginTop: 10, opacity: busy || !mtgDraft.scheduledAt ? 0.6 : 1 }}
        >
          Schedule
        </button>
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: '#8A9089' }}>
          Everyone holding a planning role is invited automatically — you don&apos;t re-pick the committee each week.
        </p>
      </div>

      {meetings.meetings.map((m) => (
        <div key={m.id} style={{ ...S.card, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 700 }}>{m.title}</div>
            <div style={{ fontSize: 13, color: '#5C6B62' }}>{dt(m.scheduledAt)}</div>
          </div>
          {m.agenda && <p style={{ margin: '8px 0 0', fontSize: 13.5, color: '#4A524C', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{m.agenda}</p>}

          {m.attendance.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={S.kick}>Attendance</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {m.attendance.map((a) => (
                  <button
                    key={a.volunteerId}
                    onClick={() => call('PATCH', {
                      kind: 'attendance', meetingId: m.id, volunteerId: a.volunteerId,
                      status: a.status === 'attended' ? 'absent' : 'attended',
                    })}
                    disabled={busy}
                    style={{
                      ...S.mini,
                      background: a.status === 'attended' ? '#E7F1EA' : a.status === 'absent' ? '#FBE9E7' : '#fff',
                      color: a.status === 'attended' ? 'var(--primary)' : a.status === 'absent' ? 'var(--alert)' : 'var(--ink)',
                    }}
                  >
                    {a.name} · {a.status}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <input
              placeholder="Log an action item from this meeting"
              value={itemDraft[m.id] ?? ''}
              onChange={(e) => setItemDraft((d) => ({ ...d, [m.id]: e.target.value }))}
              style={{ ...S.input, flex: '1 1 260px' }}
            />
            <button
              onClick={async () => {
                await call('POST', { kind: 'action_item', meetingId: m.id, description: itemDraft[m.id] ?? '' });
                setItemDraft((d) => ({ ...d, [m.id]: '' }));
              }}
              disabled={busy || !(itemDraft[m.id] ?? '').trim()}
              style={{ ...S.btn, opacity: busy || !(itemDraft[m.id] ?? '').trim() ? 0.6 : 1 }}
            >
              Log item
            </button>
          </div>
        </div>
      ))}

      {done.length > 0 && (
        <div style={S.card}>
          <div style={S.kick}>Completed</div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {done.map((i) => (
              <div key={i.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13.5, color: '#8A9089' }}>
                <span style={{ textDecoration: 'line-through', flex: 1 }}>{i.description}</span>
                <button onClick={() => call('PATCH', { kind: 'action_item', itemId: i.id })} disabled={busy} style={S.mini}>Reopen</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Tab({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} style={{
      borderRadius: 999, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
      border: on ? '1px solid var(--primary)' : '1px solid var(--line)',
      background: on ? 'var(--primary)' : '#fff', color: on ? '#fff' : 'var(--ink)',
    }}>{label}</button>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' }}>{label}</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, color: accent ?? 'var(--ink)' }}>{value}</div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'good' | 'bad'; children: React.ReactNode }) {
  const good = tone === 'good';
  return (
    <div style={{ ...S.card, marginBottom: 14, background: good ? '#E7F1EA' : '#FBE9E7', borderColor: good ? '#B7E0C6' : '#F5C6C0', padding: '14px 18px' }}>
      <p style={{ margin: 0, fontSize: 13.5, color: good ? 'var(--deep-green)' : '#7A2E1E', lineHeight: 1.55 }}>{children}</p>
    </div>
  );
}

// The organizer's side of two-way messaging, plus the guidance profiles and
// the raw send ledger — the Communication Engine's paper trail, visible.
function InboxView({ comm, draft, setDraft, onAction, busy }: {
  comm: CommData | null;
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onAction: (body: Record<string, unknown>) => void;
  busy: boolean;
}) {
  if (!comm) return <p style={{ color: '#8A9089', fontSize: 14 }}>Loading…</p>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={S.btn} disabled={busy} onClick={() => onAction({ action: 'run_reminders' })}>
          Send due reminders now
        </button>
        <span style={{ fontSize: 12.5, color: '#8A9089' }}>
          The daily run covers 7-day, 48-hour and 24-hour reminders; press this on event day for the 6-hour and 30-minute ones.
        </span>
      </div>

      {comm.threads.length === 0 && (
        <p style={{ color: '#8A9089', fontSize: 14 }}>No messages yet. Volunteers can write to you from their portal link.</p>
      )}
      {comm.threads.map((t) => (
        <div key={t.volunteerId} style={{ ...S.card, marginBottom: 10, borderColor: t.escalated ? 'var(--alert)' : 'var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 15 }}>{t.name}</strong>
            {t.unread > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#8A6D1F', background: '#FBF0DC', borderRadius: 999, padding: '2px 9px' }}>{t.unread} new</span>}
            {t.escalated && <span style={{ fontSize: 11.5, fontWeight: 700, color: '#B8442C', background: '#FBE9E7', borderRadius: 999, padding: '2px 9px' }}>Escalated to platform</span>}
          </div>
          {t.messages.map((m) => (
            <div key={m.id} style={{
              margin: '5px 0', padding: '7px 11px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.55, maxWidth: '85%',
              background: m.direction === 'to_volunteer' ? '#E7F1EA' : '#FAF8F3',
              marginLeft: m.direction === 'to_volunteer' ? 'auto' : 0,
            }}>
              {m.body}
              <span style={{ display: 'block', fontSize: 10.5, color: '#8A9089', marginTop: 2 }}>
                {m.direction === 'to_volunteer' ? 'You' : `${m.senderName ?? t.name} → ${m.audience}`}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input value={draft[t.volunteerId] ?? ''} placeholder="Reply…" style={{ ...S.input, flex: 1 }}
              onChange={(e) => setDraft((d) => ({ ...d, [t.volunteerId]: e.target.value }))} />
            <button style={S.mini} disabled={busy || !(draft[t.volunteerId] ?? '').trim()}
              onClick={() => { onAction({ action: 'reply', volunteerId: t.volunteerId, body: draft[t.volunteerId] }); setDraft((d) => ({ ...d, [t.volunteerId]: '' })); }}>
              Send
            </button>
            {t.unread > 0 && (
              <button style={S.mini} disabled={busy} onClick={() => onAction({ action: 'mark_read', volunteerId: t.volunteerId })}>Mark read</button>
            )}
          </div>
        </div>
      ))}

      {comm.profiles.length > 0 && (
        <div style={{ ...S.card, marginBottom: 10 }}>
          <p style={S.kick}>Guidance profiles — how each volunteer is being coached</p>
          {comm.profiles.map((p) => (
            <div key={p.volunteerId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 14 }}>{p.name}</strong>
              <span style={{ fontSize: 12, color: '#5C6B62' }}>
                {p.experienceLevel.replace('_', '-')} · {p.depth} instructions · {p.cadence} reminders · via {p.channel === 'in_app' ? 'the portal' : p.channel.toUpperCase()}
              </span>
              {p.recomputeReason && <span style={{ fontSize: 11, color: '#8A9089' }}>updated on {p.recomputeReason.replace('event:', '')}</span>}
            </div>
          ))}
        </div>
      )}

      {comm.ledger.length > 0 && (
        <div style={S.card}>
          <p style={S.kick}>Send ledger — every SMS, email and push, with what actually happened</p>
          {comm.ledger.slice(0, 25).map((l) => (
            <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, minWidth: 90 }}>{l.volunteerName}</span>
              <span style={{ color: '#5C6B62' }}>{l.channel.toUpperCase()} · {l.kind}{l.offsetKey ? ` · ${l.offsetKey.replace('pre_event:', '')}m out` : ''}</span>
              <span style={{ fontWeight: 700, color: l.status === 'failed' ? '#B8442C' : l.status === 'sent' || l.status === 'delivered' || l.status === 'read' ? '#1B6B3A' : '#8A6D1F' }}>{l.status}</span>
              {l.error && <span style={{ color: '#B8442C' }}>{l.error.slice(0, 80)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: 18 },
  chip: { fontSize: 12.5, fontWeight: 600, color: '#5C6B62', background: '#EFEAE0', borderRadius: 8, padding: '6px 12px' },
  row: {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
    background: '#fff', border: '1px solid var(--line)', borderRadius: 12,
    padding: '15px 18px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },
  panel: { background: '#FAF8F3', border: '1px solid var(--line)', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: 18, marginTop: -6 },
  memberRow: { display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '9px 12px', background: '#fff', borderRadius: 10, border: '1px solid var(--line)', marginBottom: 6 },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  mini: { background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
};
