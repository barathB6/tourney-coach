'use client';

import React, { useEffect, useState, use as usePromise } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { TEES, emptyHoles, isHoleComplete, completionCount, type CourseHole, type Tee } from '@/lib/course';
import { HoleEditor, TeeDistances, TeeDot } from '@/components/course/HoleEditor';
import { authedFetch } from '@/lib/authedFetch';

type Course = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  total_holes: number | null;
  par_total: number | null;
  slope: number | null;
  tees: string[] | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  charity_policy: string | null;
  organizer_id: string | null;
  profile_status: 'draft' | 'complete' | null;
};

type ProAccess = {
  active: boolean;
  email: string | null;
  loginUrl: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
};

const s = {
  page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '28px 24px 64px', color: '#1A1F1C' },
  card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 20 },
  label: { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#6B7775', textTransform: 'uppercase' as const, display: 'block', marginBottom: 6 },
  input: { width: '100%', border: '1px solid #E5E0D5', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', color: '#1A1F1C', boxSizing: 'border-box' as const },
  btn: { background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnGhost: { background: '#fff', color: '#1A1F1C', border: '1px solid #E5E0D5', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  pill: { fontSize: 12.5, fontWeight: 700, background: '#E7F1EA', color: '#1B6B3A', borderRadius: 20, padding: '7px 14px', whiteSpace: 'nowrap' as const },
};

export default function CourseBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [holes, setHoles] = useState<CourseHole[]>(emptyHoles());
  // Which holes have GPS-derived positions (from live play aggregation).
  const [gpsHoles, setGpsHoles] = useState<Record<number, boolean>>({});
  const [selectedHole, setSelectedHole] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [saveNote, setSaveNote] = useState('');

  // Delegated head-pro access. While a grant is active the course's hole data
  // belongs to the pro — the organizer keeps full visibility but drops to
  // read-only, so there's exactly one authoritative editor.
  const [proAccess, setProAccess] = useState<ProAccess | null>(null);
  const [proPanelOpen, setProPanelOpen] = useState(false);
  const [proEmail, setProEmail] = useState('');
  const [proBusy, setProBusy] = useState(false);
  const [proError, setProError] = useState('');
  const [issued, setIssued] = useState<{ loginUrl: string; password: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user;
      if (!user) { router.replace('/sign-in?next=/course/' + id); return; }
      setUserId(user.id);
      if (id === 'new') { setLoading(false); return; }

      const { data: c, error: cErr } = await supabase.from('courses').select('*').eq('id', id).maybeSingle();
      if (cErr) { setMigrationMissing(true); setLoading(false); return; }
      if (c) {
        setCourse(c as Course);
        if ((c as Course).organizer_id === user.id) {
          try { localStorage.setItem(`tourney_last_course_${user.id}`, id); } catch { /* */ }
        }
      }

      const { data: h, error: hErr } = await supabase.from('course_holes').select('*').eq('course_id', id).order('hole_number');
      if (hErr) {
        setMigrationMissing(true);
      } else if (h) {
        const next = emptyHoles();
        const gps: Record<number, boolean> = {};
        for (const row of h) {
          next[row.hole_number - 1] = { holeNumber: row.hole_number, par: row.par, handicap: row.handicap, description: row.description, shapeTags: row.shape_tags ?? [], teeYardages: row.tee_yardages ?? {} };
          const status = row.gps_status as { tee?: unknown; green?: unknown } | null;
          if (status?.tee || status?.green) gps[row.hole_number] = true;
        }
        setHoles(next);
        setGpsHoles(gps);
        // Open the first hole that still needs data, or hole 1.
        const firstIncomplete = next.find((x) => !isHoleComplete(x));
        setSelectedHole(firstIncomplete ? firstIncomplete.holeNumber : 1);
      }
      setLoading(false);
    });
  }, [id, router]);

  // Load the pro grant once we know the course exists and who's viewing.
  useEffect(() => {
    if (id === 'new' || !userId || course?.organizer_id !== userId) return;
    let cancelled = false;
    authedFetch(`/api/course/${id}/pro-access`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) setProAccess(data); })
      .catch(() => { /* the panel just stays closed */ });
    return () => { cancelled = true; };
  }, [id, userId, course?.organizer_id]);

  async function issueProAccess() {
    setProBusy(true); setProError(''); setIssued(null);
    try {
      const res = await authedFetch(`/api/course/${id}/pro-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: proEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the link');
      setProAccess({ active: true, email: data.email, loginUrl: data.loginUrl, createdAt: new Date().toISOString(), lastLoginAt: null });
      setIssued({ loginUrl: data.loginUrl, password: data.password, emailed: data.emailed });
    } catch (e) {
      setProError(e instanceof Error ? e.message : 'Could not create the link');
    } finally {
      setProBusy(false);
    }
  }

  async function revokeProAccess() {
    if (!window.confirm('Revoke the pro’s access? Their link and password stop working, and you get editing back.')) return;
    setProBusy(true); setProError('');
    try {
      const res = await authedFetch(`/api/course/${id}/pro-access`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not revoke access');
      setProAccess({ active: false, email: null, loginUrl: null, createdAt: null, lastLoginAt: null });
      setIssued(null);
    } catch (e) {
      setProError(e instanceof Error ? e.message : 'Could not revoke access');
    } finally {
      setProBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    setCopied(what); setTimeout(() => setCopied(''), 1500);
  }

  async function createCourse(fields: { name: string; address: string; city: string; state: string; zip: string }) {
    if (!userId) return;
    const { data, error } = await supabase.from('courses').insert({ ...fields, total_holes: 18, organizer_id: userId, profile_status: 'draft' }).select().single();
    if (error) { setMigrationMissing(true); return; }
    // If we arrived from a tournament (/course/new?tournament=<id>), link the new
    // course to it so each tournament owns its own course profile.
    const tournamentParam = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tournament') : null;
    if (tournamentParam) await supabase.from('tournaments').update({ course_id: data.id }).eq('id', tournamentParam);
    router.replace(`/course/${data.id}`);
  }

  async function saveCourseField(field: keyof Course, value: unknown) {
    if (!course) return;
    setCourse({ ...course, [field]: value } as Course);
    await supabase.from('courses').update({ [field]: value }).eq('id', course.id);
  }

  function toggleTee(tee: Tee) {
    if (!course) return;
    const current = course.tees ?? TEES.slice();
    const next = current.includes(tee) ? current.filter((t) => t !== tee) : [...current, tee];
    saveCourseField('tees', next);
  }

  async function saveHole(hole: CourseHole) {
    if (!course) return;
    setHoles((prev) => prev.map((h) => (h.holeNumber === hole.holeNumber ? hole : h)));
    await supabase.from('course_holes').upsert(
      { course_id: course.id, hole_number: hole.holeNumber, par: hole.par, handicap: hole.handicap, description: hole.description, shape_tags: hole.shapeTags, tee_yardages: hole.teeYardages },
      { onConflict: 'course_id,hole_number' },
    );
    const nextHoles = holes.map((h) => (h.holeNumber === hole.holeNumber ? hole : h));
    const nextStatus = completionCount(nextHoles) === 18 ? 'complete' : 'draft';
    const nextParTotal = nextHoles.reduce((sum, h) => sum + (h.par ?? 0), 0) || null;
    if (nextStatus !== course.profile_status || nextParTotal !== course.par_total) {
      await supabase.from('courses').update({ par_total: nextParTotal, profile_status: nextStatus }).eq('id', course.id);
      setCourse({ ...course, profile_status: nextStatus, par_total: nextParTotal });
    }
    setSaveNote('Saved'); setTimeout(() => setSaveNote(''), 1200);
  }

  if (loading) return <div style={s.page}>Loading…</div>;
  if (migrationMissing) {
    return <div style={s.page}><div style={{ maxWidth: 640, margin: '80px auto', ...s.card }}><p style={{ margin: 0 }}>Run migration <code>023_course_builder.sql</code> in Supabase to enable the course builder — the required columns/tables aren&apos;t there yet.</p></div></div>;
  }
  if (id === 'new') return <NewCourseForm onCreate={createCourse} onCancel={() => router.push('/dashboard')} />;
  if (!course) return <div style={s.page}><div style={{ maxWidth: 640, margin: '80px auto', ...s.card }}>Course not found.</div></div>;

  const isOwner = course.organizer_id === userId;
  // Handing the course to a pro hands over editing with it: the organizer
  // keeps full visibility, but the pro is the single source of truth for
  // hole data while their grant is live.
  const delegatedToPro = !!proAccess?.active;
  const canEdit = isOwner && !delegatedToPro;
  const done = completionCount(holes);
  const activeTees: Tee[] = (course.tees as Tee[] | null) ?? TEES.slice();
  const selected = holes[selectedHole - 1];
  const primaryTee: Tee = activeTees.includes('blue') ? 'blue' : (activeTees[0] ?? 'blue');
  const primaryYardage = holes.reduce((sum, h) => sum + (h.teeYardages[primaryTee] ?? 0), 0);
  const parTotal = holes.reduce((sum, h) => sum + (h.par ?? 0), 0) || course.par_total;
  const gpsCount = Object.keys(gpsHoles).length;
  const cardYds = (h: CourseHole) => h.teeYardages[primaryTee] ?? Object.values(h.teeYardages)[0];

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, fontWeight: 600, padding: 0 }}>← Dashboard</button>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5C6B62', background: '#EFEAD9', border: '1px solid #E5E0D5', borderRadius: 20, padding: '5px 12px' }}>PRO PORTAL</span>
        </div>

        <div style={{ marginBottom: 22 }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 38, lineHeight: 1.05, margin: '0 0 10px' }}>Golf Pro Course Builder</h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.5, color: '#5C6B62', maxWidth: 680, margin: 0 }}>
            Where the head pro spends 30–45 minutes once and never again. 18 hole cards with par, yardage, handicap. The GPS schema lives behind the scenes — invisible to the pro, but it&apos;s the patent-priority data structure.
          </p>
        </div>

        {/* Course header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
          <div>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, margin: 0 }}>{course.name}</h2>
            <p style={{ color: '#6B7775', fontSize: 14, margin: '4px 0 0' }}>
              {parTotal ? `Par ${parTotal}` : 'Par —'}
              {primaryYardage > 0 ? ` · ${primaryYardage.toLocaleString()} yards from the ${primaryTee}s` : ''}
              {course.slope ? ` · slope ${course.slope}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={s.pill}>{done} / 18 holes complete</span>
            {isOwner && (
              <button style={s.btnGhost} onClick={() => setProPanelOpen((v) => !v)}>
                {delegatedToPro ? 'Pro access · active' : 'Send to golf pro'}
              </button>
            )}
            {canEdit ? <button style={s.btn} onClick={() => { setSaveNote('Saved'); setTimeout(() => setSaveNote(''), 1200); }}>{saveNote || 'Save course'}</button>
              : isOwner ? <span style={{ fontSize: 12, color: '#B08900', background: '#FFF7E0', padding: '5px 11px', borderRadius: 20 }}>View only — the golf pro is editing</span>
              : <span style={{ fontSize: 12, color: '#B08900', background: '#FFF7E0', padding: '5px 11px', borderRadius: 20 }}>Read-only — you didn&apos;t create this profile</span>}
          </div>
        </div>

        {isOwner && proPanelOpen && (
          <div style={{ ...s.card, marginBottom: 18 }}>
            <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, margin: '0 0 4px' }}>Send this course to the golf pro</h3>
            <p style={{ fontSize: 13.5, color: '#6B7775', lineHeight: 1.55, margin: '0 0 16px', maxWidth: 620 }}>
              The pro gets their own link and a password — no account, no signup. Every hole arrives pre-filled with typical distances, so it&apos;s a review-and-correct pass of about 25 minutes. While their access is active you keep watching every change here, but they hold the pen.
            </p>

            {proAccess?.active ? (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start', marginBottom: 14 }}>
                  <div>
                    <label style={s.label}>Issued to</label>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{proAccess.email}</p>
                  </div>
                  <div>
                    <label style={s.label}>Status</label>
                    <p style={{ margin: 0, fontSize: 14 }}>
                      {proAccess.lastLoginAt
                        ? `Signed in ${new Date(proAccess.lastLoginAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                        : 'Invitation sent — not opened yet'}
                    </p>
                  </div>
                </div>
                {proAccess.loginUrl && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                    <code style={{ fontSize: 12.5, background: '#F7F5EE', border: '1px solid #E5E0D5', borderRadius: 8, padding: '8px 11px', wordBreak: 'break-all' }}>{proAccess.loginUrl}</code>
                    <button style={s.btnGhost} onClick={() => copy(proAccess.loginUrl!, 'link')}>{copied === 'link' ? 'Copied ✓' : 'Copy link'}</button>
                  </div>
                )}
                {issued && (
                  <div style={{ background: '#EEF5F0', border: '1px solid #CDE3D5', borderRadius: 10, padding: '13px 15px', marginBottom: 14 }}>
                    <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#1B4425' }}>
                      Password {issued.emailed ? '· also emailed to the pro' : '· email not sent, share this yourself'}
                    </p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <code style={{ fontSize: 17, fontWeight: 700, color: '#1B6B3A' }}>{issued.password}</code>
                      <button style={s.btnGhost} onClick={() => copy(issued.password, 'pw')}>{copied === 'pw' ? 'Copied ✓' : 'Copy'}</button>
                    </div>
                    <p style={{ margin: '8px 0 0', fontSize: 12, color: '#5C6B62' }}>Shown once. Re-send below if the pro needs it again.</p>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={s.btnGhost} disabled={proBusy} onClick={() => { setProEmail(proAccess.email ?? ''); issueProAccess(); }}>
                    {proBusy ? 'Working…' : 'Re-send invitation'}
                  </button>
                  <button style={{ ...s.btnGhost, color: '#B91C1C' }} disabled={proBusy} onClick={revokeProAccess}>Revoke access</button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', maxWidth: 560 }}>
                <div style={{ flex: '1 1 260px' }}>
                  <label style={s.label}>Golf pro&apos;s email</label>
                  <input type="email" style={s.input} placeholder="pro@beauchene.com" value={proEmail} onChange={(e) => setProEmail(e.target.value)} />
                </div>
                <button style={s.btn} disabled={proBusy || !proEmail.trim()} onClick={issueProAccess}>
                  {proBusy ? 'Creating…' : 'Create pro login link'}
                </button>
              </div>
            )}
            {proError && <p style={{ margin: '12px 0 0', fontSize: 13, color: '#B91C1C' }}>{proError}</p>}
          </div>
        )}

        {/* Hole cards — two rows of nine */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, minmax(0, 1fr))', gap: 10, marginBottom: 22 }}>
          {holes.map((h) => {
            const complete = isHoleComplete(h);
            const active = selectedHole === h.holeNumber;
            return (
              <button key={h.holeNumber} onClick={() => setSelectedHole(h.holeNumber)} style={{
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                background: active ? '#EAF3EC' : complete ? '#fff' : '#FBFAF6',
                border: active ? '1.5px solid #1B6B3A' : complete ? '1px solid #E5E0D5' : '1px dashed #D8D2C2',
                borderRadius: 12, padding: '12px 6px 10px',
              }}>
                <span style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, color: '#1B6B3A' }}>{h.holeNumber}</span>
                {complete ? (
                  <>
                    <span style={{ fontSize: 10, color: '#8A9089' }}>{cardYds(h)} yds · HCP {h.handicap ?? '—'}</span>
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

        {/* Selected hole + GPS status */}
        <div className="tc-course-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
          {canEdit
            ? <HoleEditor key={selected.holeNumber} hole={selected} tees={activeTees} onSave={saveHole} />
            : <TeeDistances hole={selected} tees={activeTees} />}

          <div style={{ ...s.card }}>
            <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, margin: '0 0 8px' }}>GPS data status</h3>
            <p style={{ fontSize: 13.5, color: '#6B7775', lineHeight: 1.5, margin: 0 }}>
              Tee, fairway, and green positions for every hole are mapped automatically from player phones during your tournaments. No survey work required. After 3–5 events at this course, hazard outlines and pin tendencies fill in too.
            </p>
            {gpsCount > 0 ? (
              <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 700, color: '#1B6B3A', background: '#E9F4ED', border: '1px solid #BFE0CB', borderRadius: 10, padding: '11px 13px' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#1B9E4B', flexShrink: 0 }} />
                Active — positions mapped on {gpsCount} of 18 hole{gpsCount === 1 ? '' : 's'}
              </div>
            ) : (
              <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 700, color: '#8A6D00', background: '#FFF3D0', border: '1px solid #F0DE9E', borderRadius: 10, padding: '11px 13px' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#C08A1E', flexShrink: 0 }} />
                Not yet collecting — schema attached, no rounds recorded
              </div>
            )}
            <p style={{ fontSize: 11.5, color: '#9A9587', margin: '10px 0 0' }}>
              {gpsCount > 0 ? 'Accuracy tightens with every tournament played on this course.' : 'Starts automatically the first time this course hosts a live tournament.'}
            </p>
          </div>
        </div>

        {/* Course metadata (spec-required; tucked below the mockup surface) */}
        {isOwner && (
          <details style={{ ...s.card, padding: 0, overflow: 'hidden' }}>
            <summary style={{ cursor: 'pointer', padding: '14px 20px', fontFamily: "'Fraunces', serif", fontSize: 16, listStyle: 'none' }}>
              Course details, contact &amp; charity policy
            </summary>
            <div style={{ padding: '0 20px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Field label="Course name" value={course.name} onCommit={(v) => saveCourseField('name', v)} />
                <Field label="Address" value={course.address ?? ''} onCommit={(v) => saveCourseField('address', v)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <Field label="City" value={course.city ?? ''} onCommit={(v) => saveCourseField('city', v)} />
                  <Field label="State" value={course.state ?? ''} onCommit={(v) => saveCourseField('state', v)} />
                  <Field label="Slope" value={course.slope != null ? String(course.slope) : ''} onCommit={(v) => saveCourseField('slope', v ? Number(v) : null)} />
                </div>
                <div>
                  <label style={s.label}>Tees offered</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {TEES.map((tee) => (
                      <button key={tee} onClick={() => toggleTee(tee)} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit',
                        border: activeTees.includes(tee) ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                        background: activeTees.includes(tee) ? '#1B6B3A' : '#fff',
                        color: activeTees.includes(tee) ? '#fff' : '#6B7775',
                      }}><TeeDot tee={tee} />{tee[0].toUpperCase() + tee.slice(1)}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Field label="Contact name" value={course.contact_name ?? ''} onCommit={(v) => saveCourseField('contact_name', v)} />
                <Field label="Email" value={course.contact_email ?? ''} onCommit={(v) => saveCourseField('contact_email', v)} />
                <Field label="Phone" value={course.contact_phone ?? ''} onCommit={(v) => saveCourseField('contact_phone', v)} />
                <div>
                  <label style={s.label}>Charity tournament policy</label>
                  <textarea defaultValue={course.charity_policy ?? ''} rows={3} placeholder="Rental/cart policy, shotgun restrictions, insurance, etc."
                    onBlur={(e) => saveCourseField('charity_policy', e.target.value)} style={{ ...s.input, resize: 'vertical' }} />
                </div>
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <div>
      <label style={s.label}>{label}</label>
      <input key={value} style={s.input} defaultValue={value} onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }} />
    </div>
  );
}

function NewCourseForm({ onCreate, onCancel }: { onCreate: (f: { name: string; address: string; city: string; state: string; zip: string }) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', address: '', city: '', state: '', zip: '' });
  return (
    <div style={s.page}>
      <div style={{ maxWidth: 480, margin: '80px auto', ...s.card }}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, margin: '0 0 4px' }}>New course profile</h1>
        <p style={{ color: '#6B7775', fontSize: 14, margin: '0 0 20px' }}>Start with the basics — you&apos;ll fill in all 18 holes next.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={s.label}>Course name *</label>
            <input style={s.input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g., Beau Chêne Country Club" />
          </div>
          <div>
            <label style={s.label}>Address</label>
            <input style={s.input} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <input style={s.input} placeholder="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
            <input style={s.input} placeholder="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
            <input style={s.input} placeholder="Zip" value={f.zip} onChange={(e) => setF({ ...f, zip: e.target.value })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button style={s.btnGhost} onClick={onCancel}>Cancel</button>
          <button style={s.btn} disabled={!f.name.trim()} onClick={() => onCreate(f)}>Create &amp; start building</button>
        </div>
      </div>
    </div>
  );
}
