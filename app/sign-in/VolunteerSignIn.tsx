'use client';

import React, { useState } from 'react';

// Volunteers do not have accounts and never will. Asking a retired member of
// the church committee to create a password before she can hand out gift bags
// is how a tournament loses volunteers. She types the email or phone the
// organizer already has, and we send her link back to it.
export default function VolunteerSignIn({ onBack }: { onBack: () => void }) {
  const [contact, setContact] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !contact.trim()) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/volunteer/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error || 'Could not send your link.'); return; }
      setSent(true);
    } catch {
      setError('Could not reach TourneyCoach. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  // A volunteer who still has the link in a text can paste it rather than wait
  // for another one.
  function openPasted() {
    const m = pasted.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (!m) { setError('That does not look like a volunteer link.'); return; }
    window.location.href = `/v/${m[0]}`;
  }

  return (
    <div style={S.card}>
      <button onClick={onBack} style={S.back}>← Back</button>

      {sent ? (
        <>
          <h2 style={S.h2}>Check your messages</h2>
          <p style={S.p}>
            If that email or phone is on a volunteer list, your link is on its way. It never
            expires — save it to your home screen and it becomes your tournament app.
          </p>
          <button onClick={() => { setSent(false); setContact(''); }} style={S.ghost}>Try a different one</button>
        </>
      ) : (
        <>
          <h2 style={S.h2}>Volunteer sign in</h2>
          <p style={S.p}>
            No password needed. Enter the email or phone number your organizer has for you and
            we&rsquo;ll send your link.
          </p>
          <form onSubmit={submit}>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="you@example.com or (985) 555-0134"
              autoComplete="email"
              inputMode="email"
              style={S.input}
            />
            <button type="submit" disabled={busy || !contact.trim()} style={{ ...S.btn, opacity: busy || !contact.trim() ? 0.55 : 1 }}>
              {busy ? 'Sending…' : 'Send me my link'}
            </button>
          </form>

          <details style={{ marginTop: 18 }}>
            <summary style={S.summary}>I already have a link</summary>
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste the link from your email or text"
              style={{ ...S.input, marginTop: 10 }}
            />
            <button onClick={openPasted} disabled={!pasted.trim()} style={S.ghost}>Open it</button>
          </details>
        </>
      )}

      {error && <p style={S.err}>{error}</p>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 24, boxShadow: '0 4px 24px rgba(15,74,38,.08)' },
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12, fontFamily: "'DM Sans', sans-serif" },
  h2: { fontFamily: "'Fraunces', serif", fontSize: 22, margin: '0 0 8px', color: 'var(--ink)' },
  p: { margin: '0 0 16px', fontSize: 14, lineHeight: 1.6, color: 'var(--ink)', opacity: 0.7, fontFamily: "'DM Sans', sans-serif" },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 14px', fontSize: 16, fontFamily: "'DM Sans', sans-serif", boxSizing: 'border-box', marginBottom: 10 },
  btn: { width: '100%', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10, padding: '14px 18px', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  ghost: { width: '100%', background: '#fff', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", marginTop: 8 },
  summary: { fontSize: 13.5, color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  err: { marginTop: 12, fontSize: 13, color: 'var(--alert)', fontFamily: "'DM Sans', sans-serif" },
};
