'use client';

import React, { useEffect, useState, use as usePromise } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { TEES, TEE_LABELS, emptyHoles, isHoleComplete, completionCount, type CourseHole, type Tee } from '@/lib/course';

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

const s = {
  page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
  card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 12, padding: 20 },
  label: { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#6B7775', textTransform: 'uppercase' as const, display: 'block', marginBottom: 6 },
  input: { width: '100%', border: '1px solid #E5E0D5', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', color: '#1A1F1C', boxSizing: 'border-box' as const },
  btn: { background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  btnGhost: { background: '#fff', color: '#1A1F1C', border: '1px solid #E5E0D5', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
};

export default function CourseBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [holes, setHoles] = useState<CourseHole[]>(emptyHoles());
  const [selectedHole, setSelectedHole] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [saveNote, setSaveNote] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user;
      if (!user) { router.replace('/sign-in'); return; }
      setUserId(user.id);

      if (id === 'new') {
        setLoading(false);
        return;
      }

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
        for (const row of h) {
          next[row.hole_number - 1] = {
            holeNumber: row.hole_number,
            par: row.par,
            handicap: row.handicap,
            description: row.description,
            teeYardages: row.tee_yardages ?? {},
          };
        }
        setHoles(next);
      }
      setLoading(false);
    });
  }, [id, router]);

  async function createCourse(fields: { name: string; address: string; city: string; state: string; zip: string }) {
    if (!userId) return;
    const { data, error } = await supabase
      .from('courses')
      .insert({ ...fields, total_holes: 18, organizer_id: userId, profile_status: 'draft' })
      .select()
      .single();
    if (error) { setMigrationMissing(true); return; }
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
    const next = current.includes(tee) ? current.filter(t => t !== tee) : [...current, tee];
    saveCourseField('tees', next);
  }

  async function saveHole(hole: CourseHole) {
    if (!course) return;
    setHoles(prev => prev.map(h => (h.holeNumber === hole.holeNumber ? hole : h)));
    await supabase.from('course_holes').upsert(
      {
        course_id: course.id,
        hole_number: hole.holeNumber,
        par: hole.par,
        handicap: hole.handicap,
        description: hole.description,
        tee_yardages: hole.teeYardages,
      },
      { onConflict: 'course_id,hole_number' },
    );
    const nextHoles = holes.map(h => (h.holeNumber === hole.holeNumber ? hole : h));
    const done = completionCount(nextHoles);
    const nextStatus = done === 18 ? 'complete' : 'draft';
    const nextParTotal = nextHoles.reduce((sum, h) => sum + (h.par ?? 0), 0) || null;
    if (nextStatus !== course.profile_status || nextParTotal !== course.par_total) {
      await supabase.from('courses').update({ par_total: nextParTotal, profile_status: nextStatus }).eq('id', course.id);
      setCourse({ ...course, profile_status: nextStatus, par_total: nextParTotal });
    }
    setSaveNote('Saved');
    setTimeout(() => setSaveNote(''), 1200);
  }

  if (loading) return <div style={s.page}>Loading…</div>;

  if (migrationMissing) {
    return (
      <div style={s.page}>
        <div style={{ maxWidth: 640, margin: '80px auto', ...s.card }}>
          <p style={{ margin: 0 }}>Run migration <code>023_course_builder.sql</code> in Supabase to enable the course builder — the required columns/tables aren&apos;t there yet.</p>
        </div>
      </div>
    );
  }

  if (id === 'new') {
    return <NewCourseForm onCreate={createCourse} onCancel={() => router.push('/dashboard')} />;
  }

  if (!course) {
    return (
      <div style={s.page}>
        <div style={{ maxWidth: 640, margin: '80px auto', ...s.card }}>Course not found.</div>
      </div>
    );
  }

  const isOwner = course.organizer_id === userId;
  const done = completionCount(holes);
  const activeTees: Tee[] = (course.tees as Tee[] | null) ?? TEES.slice();
  const selected = selectedHole != null ? holes[selectedHole - 1] : null;

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>← Back to dashboard</button>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
          <div>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>{course.name}</h1>
            <p style={{ color: '#6B7775', fontSize: 14, margin: '4px 0 0' }}>
              Par {holes.reduce((sum, h) => sum + (h.par ?? 0), 0) || (course.par_total ?? '—')}
              {course.total_holes ? ` · ${course.city ?? ''}${course.city && course.state ? ', ' : ''}${course.state ?? ''}` : ''}
              {course.slope ? ` · slope ${course.slope}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: '#6B7775' }}>{saveNote || `${done} / 18 holes complete`}</span>
            {!isOwner && <span style={{ fontSize: 12, color: '#B08900', background: '#FFF7E0', padding: '4px 10px', borderRadius: 20 }}>Read-only — you didn&apos;t create this profile</span>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 20 }}>
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 10, marginBottom: 20 }}>
              {holes.map(h => {
                const complete = isHoleComplete(h);
                const active = selectedHole === h.holeNumber;
                return (
                  <button key={h.holeNumber} onClick={() => setSelectedHole(h.holeNumber)}
                    style={{
                      textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                      background: active ? '#EAF3EC' : '#fff',
                      border: active ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                      borderRadius: 10, padding: '10px 10px 12px',
                    }}>
                    <div style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700 }}>{h.holeNumber}</div>
                    {complete ? (
                      <>
                        <div style={{ fontSize: 10.5, color: '#6B7775', marginTop: 2 }}>{h.teeYardages[activeTees[0]] ?? Object.values(h.teeYardages)[0]} yds{h.handicap ? ` · HCP ${h.handicap}` : ''}</div>
                        <div style={{ marginTop: 6, fontSize: 10.5, fontWeight: 700, background: '#F1ECDD', color: '#1A1F1C', borderRadius: 5, padding: '3px 6px', display: 'inline-block' }}>PAR {h.par}</div>
                      </>
                    ) : (
                      <div style={{ fontSize: 11, color: '#B0A98F', marginTop: 4 }}>Tap to add</div>
                    )}
                  </button>
                );
              })}
            </div>

            {selected && isOwner && (
              <HoleEditor key={selected.holeNumber} hole={selected} tees={activeTees} onSave={saveHole} />
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={s.card}>
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 16, margin: '0 0 12px' }}>Course details</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Field label="Course name" value={course.name} disabled={!isOwner} onCommit={v => saveCourseField('name', v)} />
                <Field label="Address" value={course.address ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('address', v)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <Field label="City" value={course.city ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('city', v)} />
                  <Field label="State" value={course.state ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('state', v)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <Field label="Zip" value={course.zip ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('zip', v)} />
                  <Field label="Slope" value={course.slope != null ? String(course.slope) : ''} disabled={!isOwner} onCommit={v => saveCourseField('slope', v ? Number(v) : null)} />
                </div>
              </div>
            </div>

            <div style={s.card}>
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 16, margin: '0 0 12px' }}>Contact</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Field label="Contact name" value={course.contact_name ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('contact_name', v)} />
                <Field label="Email" value={course.contact_email ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('contact_email', v)} />
                <Field label="Phone" value={course.contact_phone ?? ''} disabled={!isOwner} onCommit={v => saveCourseField('contact_phone', v)} />
              </div>
            </div>

            <div style={s.card}>
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 16, margin: '0 0 12px' }}>Charity tournament policy</h3>
              <textarea defaultValue={course.charity_policy ?? ''} disabled={!isOwner} rows={4}
                placeholder="Rental/cart policy, shotgun start restrictions, insurance requirements, etc."
                onBlur={e => saveCourseField('charity_policy', e.target.value)}
                style={{ ...s.input, resize: 'vertical' as const }} />
            </div>

            <div style={s.card}>
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 16, margin: '0 0 12px' }}>Tees offered</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {TEES.map(tee => (
                  <button key={tee} disabled={!isOwner} onClick={() => toggleTee(tee)}
                    style={{
                      fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 16, cursor: isOwner ? 'pointer' : 'default', fontFamily: 'inherit',
                      border: activeTees.includes(tee) ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                      background: activeTees.includes(tee) ? '#1B6B3A' : '#fff',
                      color: activeTees.includes(tee) ? '#fff' : '#6B7775',
                    }}>
                    {tee[0].toUpperCase() + tee.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ ...s.card, background: '#F6F4EC' }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 16, margin: '0 0 8px' }}>GPS data status</h3>
              <p style={{ fontSize: 13, color: '#6B7775', lineHeight: 1.5, margin: 0 }}>
                Each hole has a structural slot ready for tee, fairway, and green positions. GPS mapping from player phones during live tournaments isn&apos;t wired up yet — that starts once this course is used in a real event.
              </p>
              <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600, color: '#8A6D00', background: '#FFF3D0', borderRadius: 8, padding: '8px 10px' }}>
                Not yet collecting — schema is attached, no rounds recorded
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, disabled, onCommit }: { label: string; value: string; disabled?: boolean; onCommit: (v: string) => void }) {
  return (
    <div>
      <label style={s.label}>{label}</label>
      <input key={value} style={s.input} defaultValue={value} disabled={disabled}
        onBlur={e => { if (e.target.value !== value) onCommit(e.target.value); }} />
    </div>
  );
}

function HoleEditor({ hole, tees, onSave }: { hole: CourseHole; tees: Tee[]; onSave: (h: CourseHole) => void }) {
  const [local, setLocal] = useState<CourseHole>(hole);

  function commit(next: CourseHole) {
    setLocal(next);
    onSave(next);
  }

  return (
    <div style={s.card}>
      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, margin: '0 0 14px' }}>Hole {hole.holeNumber} — tee distances</h3>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <label style={s.label}>Par</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {[3, 4, 5].map(p => (
              <button key={p} onClick={() => commit({ ...local, par: p })}
                style={{
                  width: 40, height: 36, borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14, fontFamily: 'inherit',
                  border: local.par === p ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                  background: local.par === p ? '#1B6B3A' : '#fff',
                  color: local.par === p ? '#fff' : '#1A1F1C',
                }}>{p}</button>
            ))}
          </div>
        </div>
        <div style={{ width: 120 }}>
          <label style={s.label}>Handicap (1–18)</label>
          <input type="number" min={1} max={18} style={s.input} value={local.handicap ?? ''}
            onChange={e => setLocal({ ...local, handicap: e.target.value ? Number(e.target.value) : null })}
            onBlur={() => commit(local)} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {tees.map(tee => (
          <div key={tee} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F1ECDD' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{tee[0].toUpperCase() + tee.slice(1)}</span>
            <span style={{ fontSize: 12, color: '#6B7775', flex: 1, marginLeft: 12 }}>{TEE_LABELS[tee]}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="number" style={{ ...s.input, width: 90, textAlign: 'right' }} value={local.teeYardages[tee] ?? ''}
                onChange={e => setLocal({ ...local, teeYardages: { ...local.teeYardages, [tee]: e.target.value ? Number(e.target.value) : undefined } })}
                onBlur={() => commit(local)} />
              <span style={{ fontSize: 12, color: '#6B7775' }}>yds</span>
            </div>
          </div>
        ))}
      </div>

      <label style={s.label}>Hole description (optional)</label>
      <textarea rows={2} style={{ ...s.input, resize: 'vertical' as const }} defaultValue={local.description ?? ''}
        onBlur={e => commit({ ...local, description: e.target.value })} />
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
            <input style={s.input} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g., Beau Chêne Country Club" />
          </div>
          <div>
            <label style={s.label}>Address</label>
            <input style={s.input} value={f.address} onChange={e => setF({ ...f, address: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <input style={s.input} placeholder="City" value={f.city} onChange={e => setF({ ...f, city: e.target.value })} />
            <input style={s.input} placeholder="State" value={f.state} onChange={e => setF({ ...f, state: e.target.value })} />
            <input style={s.input} placeholder="Zip" value={f.zip} onChange={e => setF({ ...f, zip: e.target.value })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button style={s.btnGhost} onClick={onCancel}>Cancel</button>
          <button style={s.btn} disabled={!f.name.trim()} onClick={() => onCreate(f)}>Create & start building</button>
        </div>
      </div>
    </div>
  );
}
