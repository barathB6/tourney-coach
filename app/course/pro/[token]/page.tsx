'use client';

import React, { useEffect, useState, use as usePromise } from 'react';
import { HoleEditor, cs } from '@/components/course/HoleEditor';
import { TEES, emptyHoles, completionCount, isHoleComplete, type CourseHole, type Tee } from '@/lib/course';

// The head pro's editor. No Supabase Auth and no account — they arrive from
// an emailed link and sign in with the email + issued password the organizer
// gave them. The session token lives in localStorage so a refresh mid-pass
// doesn't cost them their place.

type ProCourse = { id: string; name: string; city: string | null; state: string | null; tees: string[] | null; total_holes: number | null; par_total: number | null };
type HoleRow = { hole_number: number; par: number | null; handicap: number | null; description: string | null; shape_tags: string[] | null; tee_yardages: Partial<Record<Tee, number>> | null };

const sessionKey = (token: string) => `tc_pro_session_${token}`;

const s = {
  page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '28px 24px 64px', color: '#1A1F1C' },
  btn: { background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 9, padding: '11px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  pill: { fontSize: 12.5, fontWeight: 700, background: '#E7F1EA', color: '#1B6B3A', borderRadius: 20, padding: '7px 14px', whiteSpace: 'nowrap' as const },
};

function toCourseHoles(rows: HoleRow[]): CourseHole[] {
  const next = emptyHoles();
  for (const r of rows) {
    next[r.hole_number - 1] = {
      holeNumber: r.hole_number, par: r.par, handicap: r.handicap,
      description: r.description, shapeTags: r.shape_tags ?? [], teeYardages: r.tee_yardages ?? {},
    };
  }
  return next;
}

export default function ProCoursePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = usePromise(params);

  const [resumeChecked, setResumeChecked] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [course, setCourse] = useState<ProCourse | null>(null);
  const [holes, setHoles] = useState<CourseHole[]>(emptyHoles());
  const [selectedHole, setSelectedHole] = useState(1);
  const [saveNote, setSaveNote] = useState('');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState('');

  function adopt(data: { course: ProCourse; holes: HoleRow[] }) {
    setCourse(data.course);
    const next = toCourseHoles(data.holes);
    setHoles(next);
    setSelectedHole(next.find((h) => !isHoleComplete(h))?.holeNumber ?? 1);
  }

  // Resume an existing session before showing the sign-in form, so a refresh
  // lands the pro straight back in the editor.
  useEffect(() => {
    let cancelled = false;
    let saved: string | null = null;
    try { saved = localStorage.getItem(sessionKey(token)); } catch { /* ignore */ }

    (async () => {
      if (saved) {
        try {
          const res = await fetch(`/api/course/pro?session=${encodeURIComponent(saved)}`);
          if (cancelled) return;
          if (res.ok) {
            const data = await res.json();
            setSessionToken(saved);
            adopt(data);
            setEmail(data.email ?? '');
          } else {
            try { localStorage.removeItem(sessionKey(token)); } catch { /* ignore */ }
          }
        } catch { /* fall through to the sign-in form */ }
      }
      if (!cancelled) setResumeChecked(true);
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setSigningIn(true);
    setError('');
    try {
      const res = await fetch('/api/course/pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', linkToken: token, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      try { localStorage.setItem(sessionKey(token), data.sessionToken); } catch { /* ignore */ }
      setSessionToken(data.sessionToken);
      adopt(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setSigningIn(false);
    }
  }

  async function saveHole(hole: CourseHole) {
    if (!sessionToken) return;
    setHoles((prev) => prev.map((h) => (h.holeNumber === hole.holeNumber ? hole : h)));
    const res = await fetch('/api/course/pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', sessionToken, hole }),
    });
    if (res.status === 401) {
      try { localStorage.removeItem(sessionKey(token)); } catch { /* ignore */ }
      setSessionToken(null);
      setError('Your session expired — please sign in again.');
      return;
    }
    setSaveNote(res.ok ? 'Saved' : 'Save failed');
    setTimeout(() => setSaveNote(''), 1400);
  }

  if (!resumeChecked) return <div style={s.page}><p style={{ color: '#6B7775' }}>Loading…</p></div>;

  if (!sessionToken || !course) {
    return (
      <div style={s.page}>
        <div style={{ maxWidth: 420, margin: '64px auto', ...cs.card }}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1B6B3A', margin: '0 0 8px' }}>Golf Pro access</p>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 25, margin: '0 0 6px' }}>Confirm your course data</h1>
          <p style={{ color: '#6B7775', fontSize: 14, lineHeight: 1.55, margin: '0 0 22px' }}>
            Sign in with the email and password from your invitation. Everything is pre-filled with typical distances — this is a review-and-correct pass, about 25 minutes.
          </p>
          <form onSubmit={signIn}>
            <label style={cs.label}>Email</label>
            <input type="email" required autoComplete="username" style={{ ...cs.input, marginBottom: 14 }} value={email} onChange={(e) => setEmail(e.target.value)} />
            <label style={cs.label}>Password</label>
            <input type="password" required autoComplete="current-password" style={{ ...cs.input, marginBottom: 18 }} value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <p style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#B91C1C', margin: '0 0 14px' }}>{error}</p>}
            <button type="submit" disabled={signingIn} style={{ ...s.btn, width: '100%', opacity: signingIn ? 0.6 : 1 }}>
              {signingIn ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p style={{ fontSize: 12, color: '#9AA39D', margin: '16px 0 0', lineHeight: 1.5 }}>
            Trouble signing in? Ask the tournament organizer to re-send your invitation.
          </p>
        </div>
      </div>
    );
  }

  const activeTees: Tee[] = (course.tees as Tee[] | null) ?? TEES.slice();
  const done = completionCount(holes);
  const selected = holes[selectedHole - 1];
  const primaryTee: Tee = activeTees.includes('blue') ? 'blue' : (activeTees[0] ?? 'blue');
  const parTotal = holes.reduce((sum, h) => sum + (h.par ?? 0), 0) || course.par_total;
  const cardYds = (h: CourseHole) => h.teeYardages[primaryTee] ?? Object.values(h.teeYardages)[0];

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5C6B62', background: '#EFEAD9', border: '1px solid #E5E0D5', borderRadius: 20, padding: '5px 12px' }}>PRO PORTAL</span>
        </div>

        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, lineHeight: 1.1, margin: '0 0 6px' }}>{course.name}</h1>
          <p style={{ fontSize: 14.5, color: '#5C6B62', margin: 0 }}>
            {parTotal ? `Par ${parTotal}` : 'Par —'}
            {[course.city, course.state].filter(Boolean).length ? ` · ${[course.city, course.state].filter(Boolean).join(', ')}` : ''}
            {` · signed in as ${email}`}
          </p>
        </div>

        <div style={{ background: '#EEF5F0', border: '1px solid #CDE3D5', borderRadius: 12, padding: '13px 16px', marginBottom: 20, fontSize: 13.5, color: '#1B4425', lineHeight: 1.55 }}>
          Every hole is pre-filled with typical distances for its par. Correct anything that&apos;s off — each change saves on its own and the organizer sees it right away.
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <span style={s.pill}>{done} / 18 holes complete</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: saveNote === 'Save failed' ? '#B91C1C' : '#1B6B3A', minHeight: 18 }}>{saveNote}</span>
        </div>

        <div className="tc-hole-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 10, marginBottom: 20 }}>
          {holes.map((h) => {
            const active = selectedHole === h.holeNumber;
            const complete = isHoleComplete(h);
            return (
              <button
                key={h.holeNumber}
                onClick={() => setSelectedHole(h.holeNumber)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '12px 6px 10px', cursor: 'pointer',
                  fontFamily: 'inherit', borderRadius: 12,
                  border: active ? '2px solid #1B6B3A' : complete ? '1px solid #E5E0D5' : '1px dashed #D8D2C2',
                  background: active ? '#EEF5F0' : '#fff',
                }}
              >
                <span style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, color: '#1B6B3A' }}>{h.holeNumber}</span>
                {complete ? (
                  <>
                    <span style={{ fontSize: 10.5, color: '#6B7775' }}>{cardYds(h)} yds{h.handicap ? ` · HCP ${h.handicap}` : ''}</span>
                    <span style={{ width: '100%', marginTop: 4, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, background: '#F1ECDD', color: '#1A1F1C', borderRadius: 6, padding: '4px 0' }}>PAR {h.par}</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 10, color: '#B0A98F' }}>Tap to add</span>
                    <span style={{ width: '100%', marginTop: 4, fontSize: 11, fontWeight: 700, background: '#F4F1E8', color: '#B0A98F', borderRadius: 6, padding: '4px 0' }}>—</span>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ maxWidth: 620 }}>
          <HoleEditor key={selected.holeNumber} hole={selected} tees={activeTees} onSave={saveHole} />
        </div>

        <p style={{ fontSize: 12.5, color: '#9AA39D', marginTop: 22 }}>
          Changes save automatically. You can close this page and come back to the same link any time.
        </p>
      </div>
    </div>
  );
}
