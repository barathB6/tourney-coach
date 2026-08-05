'use client';

import React, { useEffect, useState, use as usePromise } from 'react';
import { formatEventDate, formatEventTime } from '@/lib/formatEventDate';

type Invite = {
  volunteerName: string; tournamentName: string; roleName: string; roleDescription: string | null;
  phase: 'planning' | 'day_of'; startsAt: string | null; tasks: string[];
  status: string; respondedAt: string | null;
};

// The volunteer's page. No login — the token in their email or text is the
// credential. Deliberately shows only their own role: no roster, no other
// volunteers, no contact details for anyone else.
export default function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = usePromise(params);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/volunteer/respond?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok) { setInvite(d as Invite); if (d.respondedAt) setAnswered(d.status); }
        else setError(d.error || 'This invitation link is not valid.');
      })
      .catch(() => setError('Could not load this invitation.'))
      .finally(() => setLoading(false));
  }, [token]);

  async function answer(a: 'confirm' | 'decline') {
    setBusy(true);
    const res = await fetch('/api/volunteer/respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, answer: a }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'Could not record your answer.'); return; }
    setAnswered(d.status);
  }

  // Schedule instants are wall-clock at the course — format in UTC, or a
  // viewer in another timezone sees the wrong morning. Same rule as the
  // kitchen sheet (lib/formatEventDate).
  const when = invite?.startsAt
    ? `${formatEventDate(invite.startsAt)} at ${formatEventTime(invite.startsAt)}`
    : null;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ maxWidth: 560, width: '100%' }}>
        {loading ? (
          <p style={{ color: '#8A9089', textAlign: 'center' }}>Loading…</p>
        ) : error ? (
          <div style={S.card}>
            <h1 style={S.h1}>That link didn&apos;t work</h1>
            <p style={{ margin: 0, color: '#5C6B62', fontSize: 15, lineHeight: 1.6 }}>{error}</p>
            <p style={{ margin: '12px 0 0', color: '#8A9089', fontSize: 13.5, lineHeight: 1.6 }}>
              If someone asked you to help, reply to their message and they can send a fresh link.
            </p>
          </div>
        ) : !invite ? null : answered ? (
          <div style={{ ...S.card, background: answered === 'confirmed' ? '#E7F1EA' : '#fff', borderColor: answered === 'confirmed' ? '#B7E0C6' : 'var(--line)' }}>
            <h1 style={S.h1}>{answered === 'confirmed' ? 'You&rsquo;re in — thank you.' : 'Thanks for letting us know.'}</h1>
            <p style={{ margin: 0, color: '#4A524C', fontSize: 15, lineHeight: 1.6 }}>
              {answered === 'confirmed'
                ? <>You&rsquo;re down for <strong>{invite.roleName}</strong> at {invite.tournamentName}{when ? <>, starting {when}</> : null}. Your checklist is below, and reminders will reach you before your shift.</>
                : <>We&rsquo;ve told the organizer you can&rsquo;t take <strong>{invite.roleName}</strong>. No hard feelings — it helps them fill it in time.</>}
            </p>
            <button onClick={() => answer(answered === 'confirmed' ? 'decline' : 'confirm')} disabled={busy} style={{ ...S.ghost, marginTop: 16 }}>
              {answered === 'confirmed' ? 'Actually, I can’t make it' : 'Actually, I can help'}
            </button>
            {answered === 'confirmed' && <Portal token={token} />}
          </div>
        ) : (
          <div style={S.card}>
            <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--primary)' }}>
              {invite.phase === 'planning' ? 'Planning team' : 'Day of the tournament'}
            </p>
            <h1 style={S.h1}>Can you take &ldquo;{invite.roleName}&rdquo;?</h1>
            <p style={{ margin: '0 0 14px', color: '#5C6B62', fontSize: 15, lineHeight: 1.6 }}>
              Hi {invite.volunteerName} — you&rsquo;ve been asked to help with <strong>{invite.tournamentName}</strong>.
              {when ? <> This role starts {when}.</> : null}
            </p>
            {invite.roleDescription && (
              <p style={{ margin: '0 0 14px', color: '#4A524C', fontSize: 14.5, lineHeight: 1.6 }}>{invite.roleDescription}</p>
            )}
            {invite.tasks.length > 0 && (
              <div style={{ background: '#FAF8F3', border: '1px solid var(--line)', borderRadius: 12, padding: 16, marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089', marginBottom: 8 }}>What it involves</div>
                <ul style={{ margin: 0, paddingLeft: 18, color: '#4A524C', fontSize: 14, lineHeight: 1.7 }}>
                  {invite.tasks.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => answer('confirm')} disabled={busy} style={{ ...S.btn, opacity: busy ? 0.6 : 1 }}>
                {busy ? 'One moment…' : 'Yes, I can help'}
              </button>
              <button onClick={() => answer('decline')} disabled={busy} style={S.ghost}>I can&rsquo;t this time</button>
            </div>
            <p style={{ margin: '14px 0 0', fontSize: 12.5, color: '#8A9089', lineHeight: 1.6 }}>
              No account needed. You can change your answer later using this same link.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── The portal — Concept E made visible ─────────────────────────────────────
// Once confirmed, the same page becomes the volunteer's home: their checklist
// rendered at THEIR depth, their message thread, their updates, and the
// feedback controls that outrank every inferred signal.

type PortalData = {
  volunteerName: string; tournamentName: string; roleName: string;
  guidance: { depth: string; cadence: string; channel: string; experienceLevel: string; reasons: string[] };
  tasks: { id: string; title: string; lines: string[]; allDepths: { detailed: string[]; standard: string[]; minimal: string }; dueAt: string | null; completedAt: string | null }[];
  inbox: { id: string; kind: string; subject: string | null; body: string | null; createdAt: string | null; deliveredVia: string }[];
  messages: { id: string; direction: string; audience: string; senderName: string | null; body: string; createdAt: string }[];
};

function Portal({ token }: { token: string }) {
  const [data, setData] = useState<PortalData | null>(null);
  const [draft, setDraft] = useState('');
  const [audience, setAudience] = useState<'organizer' | 'lead' | 'platform'>('organizer');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = React.useCallback(() => {
    fetch(`/api/volunteer/portal?token=${encodeURIComponent(token)}`)
      .then(async (r) => { const d = await r.json().catch(() => null); if (r.ok && d) setData(d as PortalData); });
  }, [token]);
  useEffect(() => { load(); }, [load]);

  async function act(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setNote('');
    const res = await fetch('/api/volunteer/portal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    });
    const d = await res.json().catch(() => null);
    setBusy(false);
    if (res.ok && d) setData(d as PortalData);
  }

  async function enablePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setNote('This browser does not support notifications.'); return; }
      const reg = await navigator.serviceWorker.register('/push-sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setNote('Notifications were not allowed.'); return; }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      });
      await act({ action: 'subscribe_push', subscription: sub.toJSON() });
      setNote('Notifications on.');
    } catch {
      setNote('Could not turn on notifications on this device.');
    }
  }

  if (!data) return null;
  const g = data.guidance;
  const doneCount = data.tasks.filter((t) => t.completedAt).length;

  return (
    <div style={{ marginTop: 20 }}>
      {/* Checklist at this volunteer's depth */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={S.kick}>Your checklist · {doneCount}/{data.tasks.length} done</div>
        {data.tasks.map((t) => (
          <div key={t.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!t.completedAt} disabled={busy}
                onChange={() => act({ action: t.completedAt ? 'uncomplete_task' : 'complete_task', taskId: t.id })}
                style={{ marginTop: 3 }} />
              <span style={{ flex: 1 }}>
                <strong style={{ fontSize: 14.5, textDecoration: t.completedAt ? 'line-through' : 'none', color: t.completedAt ? '#8A9089' : 'var(--ink)' }}>{t.title}</strong>
                {!t.completedAt && (
                  <span style={{ display: 'block', marginTop: 4 }}>
                    {t.lines.map((l, i) => (
                      <span key={i} style={{ display: 'block', fontSize: 13.5, color: '#4A524C', lineHeight: 1.6 }}>
                        {g.depth === 'detailed' ? `${i + 1}. ` : ''}{l}
                      </span>
                    ))}
                  </span>
                )}
                {g.depth !== 'detailed' && !t.completedAt && (
                  <button style={S.link} onClick={(e) => { e.preventDefault(); setExpanded(expanded === t.id ? null : t.id); }}>
                    {expanded === t.id ? 'Less' : 'Show me the full steps'}
                  </button>
                )}
                {expanded === t.id && (
                  <span style={{ display: 'block', marginTop: 6, background: '#FAF8F3', borderRadius: 8, padding: 10 }}>
                    {t.allDepths.detailed.map((l, i) => (
                      <span key={i} style={{ display: 'block', fontSize: 13, color: '#4A524C', lineHeight: 1.6 }}>{i + 1}. {l}</span>
                    ))}
                  </span>
                )}
              </span>
            </label>
          </div>
        ))}
        <p style={{ margin: '10px 0 0', fontSize: 12, color: '#8A9089', lineHeight: 1.6 }}>
          Written for {g.experienceLevel === 'first_timer' ? 'a first-time volunteer — full detail' : g.experienceLevel === 'returning' ? 'someone who has done this before' : 'a veteran — just the reminders'}.
          {' '}
          <button style={S.link} onClick={() => act({ action: 'feedback', wantsMoreDetail: g.depth !== 'detailed', wantsLessDetail: g.depth === 'detailed' })}>
            {g.depth === 'detailed' ? 'Too much detail? Trim it down' : 'Want more detail? Get the full steps'}
          </button>
        </p>
      </div>

      {/* Messages */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={S.kick}>Messages</div>
        {data.messages.length === 0 && <p style={{ fontSize: 13.5, color: '#8A9089', margin: '6px 0 10px' }}>Questions? Ask right here — the organizer sees it immediately.</p>}
        {data.messages.map((m) => (
          <div key={m.id} style={{
            margin: '6px 0', padding: '8px 12px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.6, maxWidth: '90%',
            background: m.direction === 'from_volunteer' ? '#E7F1EA' : '#FAF8F3',
            marginLeft: m.direction === 'from_volunteer' ? 'auto' : 0,
          }}>
            {m.body}
            <span style={{ display: 'block', fontSize: 10.5, color: '#8A9089', marginTop: 3 }}>
              {m.direction === 'from_volunteer' ? `You → ${m.audience}` : (m.senderName ?? 'Organizer')}
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)} style={S.input}>
            <option value="organizer">To the organizer</option>
            <option value="lead">To my team lead</option>
            <option value="platform">Escalate to TourneyCoach</option>
          </select>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…"
            style={{ ...S.input, flex: '1 1 180px' }} />
          <button disabled={busy || !draft.trim()} style={S.btn}
            onClick={() => { act({ action: 'message', body: draft, audience }); setDraft(''); }}>Send</button>
        </div>
      </div>

      {/* Updates + channel */}
      <div style={S.card}>
        <div style={S.kick}>Updates reach you by {g.channel === 'in_app' ? 'this page' : g.channel.toUpperCase()}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button style={S.ghost} onClick={enablePush} disabled={busy}>Turn on notifications</button>
        </div>
        {note && <p style={{ fontSize: 12.5, color: '#5C6B62', margin: '8px 0 0' }}>{note}</p>}
        {data.inbox.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {data.inbox.slice(0, 8).map((m) => (
              <div key={m.id} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
                <strong style={{ fontSize: 13 }}>{m.subject ?? m.kind}</strong>
                {m.body && <span style={{ display: 'block', fontSize: 12.5, color: '#5C6B62', lineHeight: 1.55 }}>{m.body}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089', marginBottom: 8 },
  link: { background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 },
  input: { border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', fontSize: 13.5, fontFamily: 'inherit', background: '#fff' },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 18, padding: 28 },
  h1: { fontFamily: "'Fraunces', serif", fontSize: 28, lineHeight: 1.15, color: 'var(--ink)', margin: '0 0 12px' },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10, padding: '13px 22px', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  ghost: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 20px', fontSize: 14.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
};
