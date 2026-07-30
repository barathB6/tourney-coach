'use client';

import React, { useEffect, useState, use as usePromise } from 'react';

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

  const when = invite?.startsAt
    ? new Date(invite.startsAt).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
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
                ? <>You&rsquo;re down for <strong>{invite.roleName}</strong> at {invite.tournamentName}{when ? <>, starting {when}</> : null}. We&rsquo;ll text you a reminder 7 days, 2 days and 90 minutes before.</>
                : <>We&rsquo;ve told the organizer you can&rsquo;t take <strong>{invite.roleName}</strong>. No hard feelings — it helps them fill it in time.</>}
            </p>
            <button onClick={() => answer(answered === 'confirmed' ? 'decline' : 'confirm')} disabled={busy} style={{ ...S.ghost, marginTop: 16 }}>
              {answered === 'confirmed' ? 'Actually, I can’t make it' : 'Actually, I can help'}
            </button>
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

const S: Record<string, React.CSSProperties> = {
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 18, padding: 28 },
  h1: { fontFamily: "'Fraunces', serif", fontSize: 28, lineHeight: 1.15, color: 'var(--ink)', margin: '0 0 12px' },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10, padding: '13px 22px', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  ghost: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 20px', fontSize: 14.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
};
