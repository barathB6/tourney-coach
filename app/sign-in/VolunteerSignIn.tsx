'use client';

import React, { useEffect, useState } from 'react';
import { rememberRoles, readRemembered, type RememberedRole } from '@/lib/volunteer/remembered';

// Volunteer sign-in, entirely on this page.
//
// Volunteers have no account and never will. They enter the email or phone the
// organizer already has, type the 6-digit code we send, and land in their view
// without leaving the site. After that this device remembers them, so the
// second visit is a single tap.
//
// The code is not friction for its own sake: the link behind each role is a
// credential — it exposes that volunteer's details and lets whoever holds it
// decline their role or message the organizer as them. Possession of the email
// or phone is what proves identity; the code just means proving it here rather
// than hunting through an inbox.

type Step = 'contact' | 'code' | 'pick';

export default function VolunteerSignIn({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('contact');
  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [roles, setRoles] = useState<RememberedRole[]>([]);
  const [remembered, setRemembered] = useState<RememberedRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [pasted, setPasted] = useState('');

  // Anyone who has signed in on this device before skips the whole flow.
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = readRemembered();
      if (alive && saved.length) setRemembered(saved);
    })();
    return () => { alive = false; };
  }, []);

  async function post(payload: Record<string, unknown>) {
    const res = await fetch('/api/volunteer/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !contact.trim()) return;
    setBusy(true); setError(''); setInfo('');
    try {
      const { res, data } = await post({ contact });
      if (!res.ok) { setError(data.error || 'Could not send a code.'); return; }
      setInfo(data.message ?? '');
      setStep('code');
    } catch {
      setError('Could not reach TourneyCoach. Check your connection and try again.');
    } finally { setBusy(false); }
  }

  async function submitCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || code.replace(/\D/g, '').length !== 6) return;
    setBusy(true); setError(''); setInfo('');
    try {
      const { res, data } = await post({ contact, code });
      if (!res.ok) { setError(data.error || 'That code is not right.'); return; }
      const found = (data.roles ?? []) as RememberedRole[];
      if (!found.length) { setInfo(data.message ?? 'Nothing found for you yet.'); return; }
      rememberRoles(found);
      // One role is the common case — go straight in rather than making
      // somebody choose from a list of one.
      if (found.length === 1) { window.location.href = `/v/${found[0].token}`; return; }
      setRoles(found);
      setStep('pick');
    } catch {
      setError('Could not reach TourneyCoach. Check your connection and try again.');
    } finally { setBusy(false); }
  }

  function openPasted() {
    const m = pasted.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (!m) { setError('That does not look like a volunteer link.'); return; }
    window.location.href = `/v/${m[0]}`;
  }

  return (
    <div style={S.card}>
      <button onClick={step === 'contact' ? onBack : () => { setStep('contact'); setCode(''); setError(''); }} style={S.back}>
        ← Back
      </button>

      {/* Returning on the same device: no code, no email, one tap. */}
      {step === 'contact' && remembered.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <h2 style={S.h2}>Welcome back</h2>
          {remembered.map((r) => (
            <button key={r.token} onClick={() => { window.location.href = `/v/${r.token}`; }} style={S.roleBtn}>
              <span>
                <strong style={{ display: 'block', fontSize: 15 }}>{r.roleName}</strong>
                <span style={{ fontSize: 13, opacity: 0.7 }}>{r.tournamentName}</span>
              </span>
              <span aria-hidden style={{ fontSize: 18, opacity: 0.5 }}>→</span>
            </button>
          ))}
          <p style={{ ...S.p, margin: '12px 0 0', fontSize: 13 }}>Not you? Sign in below.</p>
          <hr style={S.rule} />
        </div>
      )}

      {step === 'contact' && (
        <>
          <h2 style={S.h2}>Volunteer sign in</h2>
          <p style={S.p}>
            No password. Enter the email or phone your organizer has for you and we&rsquo;ll send a
            6-digit code — you stay right here.
          </p>
          <form onSubmit={sendCode}>
            <input value={contact} onChange={(e) => setContact(e.target.value)}
              placeholder="you@example.com or (985) 555-0134"
              autoComplete="email" inputMode="email" style={S.input} />
            <button type="submit" disabled={busy || !contact.trim()}
              style={{ ...S.btn, opacity: busy || !contact.trim() ? 0.55 : 1 }}>
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
          </form>

          <details style={{ marginTop: 18 }}>
            <summary style={S.summary}>I already have a link</summary>
            <input value={pasted} onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste the link from your email or text" style={{ ...S.input, marginTop: 10 }} />
            <button onClick={openPasted} disabled={!pasted.trim()} style={S.ghost}>Open it</button>
          </details>
        </>
      )}

      {step === 'code' && (
        <>
          <h2 style={S.h2}>Enter your code</h2>
          <p style={S.p}>{info || `We sent a 6-digit code to ${contact}. It expires in 10 minutes.`}</p>
          <form onSubmit={submitCode}>
            <input value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456" inputMode="numeric" autoComplete="one-time-code"
              autoFocus maxLength={6}
              style={{ ...S.input, fontSize: 28, letterSpacing: 8, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }} />
            <button type="submit" disabled={busy || code.length !== 6}
              style={{ ...S.btn, opacity: busy || code.length !== 6 ? 0.55 : 1 }}>
              {busy ? 'Checking…' : 'Open my view'}
            </button>
          </form>
          <button onClick={() => sendCode()} disabled={busy} style={S.ghost}>Send another code</button>
        </>
      )}

      {step === 'pick' && (
        <>
          <h2 style={S.h2}>Which one?</h2>
          <p style={S.p}>You&rsquo;re on more than one volunteer list.</p>
          {roles.map((r) => (
            <button key={r.token} onClick={() => { window.location.href = `/v/${r.token}`; }} style={S.roleBtn}>
              <span>
                <strong style={{ display: 'block', fontSize: 15 }}>{r.roleName}</strong>
                <span style={{ fontSize: 13, opacity: 0.7 }}>{r.tournamentName}</span>
              </span>
              <span aria-hidden style={{ fontSize: 18, opacity: 0.5 }}>→</span>
            </button>
          ))}
        </>
      )}

      {error && <p style={S.err}>{error}</p>}
      {info && step === 'contact' && <p style={S.info}>{info}</p>}
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
  roleBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, textAlign: 'left', background: '#fff', border: '1px solid var(--primary)', borderRadius: 12, padding: '14px 16px', cursor: 'pointer', marginBottom: 8, color: 'var(--ink)', fontFamily: "'DM Sans', sans-serif" },
  rule: { border: 'none', borderTop: '1px solid var(--line)', margin: '16px 0 0' },
  summary: { fontSize: 13.5, color: 'var(--primary)', fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  err: { marginTop: 12, fontSize: 13, color: 'var(--alert)', fontFamily: "'DM Sans', sans-serif" },
  info: { marginTop: 12, fontSize: 13, color: '#5C6B62', fontFamily: "'DM Sans', sans-serif", lineHeight: 1.55 },
};
