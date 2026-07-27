'use client';

import React, { useEffect, useState } from 'react';
import { RADIUS_OPTIONS } from '@/lib/tourneycircle';

const CAUSES = ['Youth & education', 'Health & research', 'Veterans & first responders', 'Food security', 'Community & local', 'Faith-based', 'Environment', 'Animal welfare'];

type Prefs = { name: string | null; optedIn: boolean; declined: boolean; radiusMiles: number; causes: string[]; cadenceDays: number };

export default function PreferencesPage() {
  const [reg, setReg] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [radius, setRadius] = useState(25);
  const [causes, setCauses] = useState<string[]>([]);
  const [cadence, setCadence] = useState(10);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const r = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('reg') : null;
    if (!r) { setStatus('error'); return; }
    setReg(r);
    fetch(`/api/circle/opt-in?reg=${encodeURIComponent(r)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((d: Prefs) => { setPrefs(d); setRadius(d.radiusMiles); setCauses(d.causes ?? []); setCadence(d.cadenceDays); setStatus('ready'); })
      .catch(() => setStatus('error'));
  }, []);

  const toggleCause = (c: string) => setCauses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const save = async (optOut = false) => {
    if (!reg || busy) return;
    setBusy(true); setSaved('');
    const res = await fetch('/api/circle/opt-in', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(optOut ? { registrationId: reg, decline: true } : { registrationId: reg, radiusMiles: radius, causes, cadenceDays: cadence }),
    });
    setBusy(false);
    if (!res.ok) { setSaved('Could not save — try again.'); return; }
    setSaved(optOut ? 'You’ve been removed from TourneyCircle.' : 'Preferences saved.');
    if (optOut && prefs) setPrefs({ ...prefs, optedIn: false });
  };

  return (
    <div style={{ minHeight: '100vh', background: '#FAF8F3', fontFamily: "'DM Sans', sans-serif", color: '#1A1F1C', padding: '32px 20px' }}>
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#1B6B3A', marginBottom: 8 }}>TourneyCircle</div>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, margin: '0 0 6px' }}>Your notification preferences</h1>
        <p style={{ fontSize: 14, color: '#6B7775', margin: '0 0 22px', lineHeight: 1.5 }}>Control what you hear about, how far, and how often. Your info never leaves TourneyCoach — organizers only ever see aggregate counts.</p>

        {status === 'loading' && <p style={{ color: '#8A9089' }}>Loading…</p>}
        {status === 'error' && <div style={card}><p style={{ margin: 0, color: '#6B7775' }}>This preferences link is missing or invalid. Open it from your round summary or a TourneyCircle email.</p></div>}

        {status === 'ready' && prefs && (
          <>
            {!prefs.optedIn && <div style={{ ...card, background: '#FBF0DC', borderColor: '#F0DE9E', marginBottom: 16 }}><p style={{ margin: 0, fontSize: 13.5, color: '#8A6D00' }}>You’re not currently in TourneyCircle. Saving below opts you in.</p></div>}

            <div style={card}>
              <div style={kick}>Reach radius</div>
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: '2px 0 10px' }}>{radius} miles</div>
              <input type="range" min={0} max={RADIUS_OPTIONS.length - 1} step={1}
                value={Math.max(0, (RADIUS_OPTIONS as readonly number[]).indexOf(radius))}
                onChange={(e) => setRadius(RADIUS_OPTIONS[Number(e.target.value)])}
                style={{ width: '100%', accentColor: '#1B6B3A' }} aria-label="Reach radius" />
            </div>

            <div style={{ ...card, marginTop: 14 }}>
              <div style={kick}>Causes you care about <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {CAUSES.map((c) => {
                  const on = causes.includes(c);
                  return <button key={c} onClick={() => toggleCause(c)} style={{ padding: '7px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', border: on ? '1px solid #1B6B3A' : '1px solid #E5E0D5', background: on ? '#1B6B3A' : '#fff', color: on ? '#fff' : '#6B7775' }}>{c}</button>;
                })}
              </div>
            </div>

            <div style={{ ...card, marginTop: 14 }}>
              <div style={kick}>How often, at most</div>
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: '2px 0 10px' }}>every {cadence} days</div>
              <input type="range" min={5} max={21} step={1} value={cadence} onChange={(e) => setCadence(Number(e.target.value))} style={{ width: '100%', accentColor: '#1B6B3A' }} aria-label="Cadence" />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#9AA39D', marginTop: 4 }}><span>5 days</span><span>21 days</span></div>
            </div>

            <button onClick={() => save(false)} disabled={busy} style={{ width: '100%', marginTop: 18, padding: '14px', background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 12, fontWeight: 700, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : prefs.optedIn ? 'Save preferences' : 'Opt in & save'}</button>
            {prefs.optedIn && <button onClick={() => save(true)} disabled={busy} style={{ width: '100%', marginTop: 10, padding: '11px', background: 'transparent', color: '#B91C1C', border: 'none', fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit' }}>Leave TourneyCircle</button>}
            {saved && <p style={{ fontSize: 13.5, color: saved.startsWith('Could not') ? '#B91C1C' : '#1B6B3A', margin: '12px 0 0', textAlign: 'center' }}>{saved}</p>}
          </>
        )}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 18 };
const kick: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' };
