'use client';

import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import HoleSchematic from '@/components/gps/HoleSchematic';
import { HOLE_SHAPE_TAGS, HOLE_SHAPE_TAG_LABELS, describeShapeTags, emptyHoles, type CourseHole } from '@/lib/course';

type TournamentOption = { id: string; name: string; course_id: string | null };

export default function HoleMapEditor() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [selectedTournament, setSelectedTournament] = useState('');
  const [loading, setLoading] = useState(true);

  const [holes, setHoles] = useState<CourseHole[]>(emptyHoles());
  const [holesCourseId, setHolesCourseId] = useState<string | null>(null);
  const [selectedHole, setSelectedHole] = useState(1);
  const [saveNote, setSaveNote] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (!user) { router.replace('/sign-in?next=/preview/hole-map'); return; }
      setUserId(user.id);

      const { data } = await supabase
        .from('tournaments')
        .select('id, name, course_id')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false });
      const list = data ?? [];
      setTournaments(list);

      let saved: string | null = null;
      try { saved = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const stillExists = saved && list.some(t => t.id === saved);
      if (list.length > 0) setSelectedTournament(stillExists ? saved! : list[0].id);
      setLoading(false);
    });
  }, [router]);

  function selectTournament(id: string) {
    setSelectedTournament(id);
    if (userId) {
      try { localStorage.setItem(`tourney_selected_tournament_${userId}`, id); } catch { /* ignore */ }
    }
  }

  const courseId = tournaments.find(t => t.id === selectedTournament)?.course_id ?? null;
  const holesLoading = !!courseId && holesCourseId !== courseId;

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    supabase.from('course_holes').select('*').eq('course_id', courseId).order('hole_number').then(({ data }) => {
      if (cancelled) return;
      const next = emptyHoles();
      for (const row of data ?? []) {
        next[row.hole_number - 1] = { holeNumber: row.hole_number, par: row.par, handicap: row.handicap, description: row.description, shapeTags: row.shape_tags ?? [], teeYardages: row.tee_yardages ?? {} };
      }
      setHoles(next);
      setSelectedHole(1);
      setHolesCourseId(courseId);
    });
    return () => { cancelled = true; };
  }, [courseId]);

  async function toggleShapeTag(tag: string) {
    if (!courseId) return;
    const hole = holes[selectedHole - 1];
    const shapeTags = hole.shapeTags.includes(tag) ? hole.shapeTags.filter(t => t !== tag) : [...hole.shapeTags, tag];
    const next = { ...hole, shapeTags, description: describeShapeTags(shapeTags) };
    setHoles(prev => prev.map(h => (h.holeNumber === next.holeNumber ? next : h)));
    await supabase.from('course_holes').upsert(
      { course_id: courseId, hole_number: next.holeNumber, par: next.par, handicap: next.handicap, description: next.description, shape_tags: next.shapeTags, tee_yardages: next.teeYardages },
      { onConflict: 'course_id,hole_number' },
    );
    setSaveNote('Saved'); setTimeout(() => setSaveNote(''), 1200);
  }

  const s = {
    page: { minHeight: '100vh', background: '#F7F5EF', padding: '28px 20px 64px', fontFamily: "'DM Sans', sans-serif" },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: '20px 24px' },
  };

  if (loading) return <div style={s.page}><p style={{ color: '#6B7775' }}>Loading…</p></div>;

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <Link href="/dashboard" style={{ display: 'inline-block', color: '#1B6B3A', fontWeight: 600, fontSize: 13, textDecoration: 'none', marginBottom: 14 }}>← Dashboard</Link>
        <p style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, color: '#1A1F1C', margin: '0 0 6px' }}>Hole map</p>
        <p style={{ color: '#6B7775', fontSize: 14, margin: '0 0 18px', maxWidth: 640 }}>
          Tag each hole&apos;s layout and features — the hole map players see on their Live Round view is generated from these chips, until real GPS data takes over.
        </p>

        {tournaments.length === 0 ? (
          <div style={{ ...s.card, textAlign: 'center' }}>
            <p style={{ color: '#6B7775' }}>Create a tournament first.</p>
          </div>
        ) : (
          <>
            {tournaments.length > 1 && (
              <select
                value={selectedTournament}
                onChange={e => selectTournament(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 13.5, fontFamily: "'DM Sans', sans-serif", color: '#1A1F1C', background: '#fff', cursor: 'pointer', marginBottom: 18 }}
              >
                {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            <div style={s.card}>
              {!courseId ? (
                <p style={{ color: '#6B7775', fontSize: 13.5, margin: 0 }}>
                  This tournament has no course profile yet. <Link href={`/course/new?tournament=${selectedTournament}`} style={{ color: '#1B6B3A', fontWeight: 600 }}>Set one up</Link> to start tagging hole layouts.
                </p>
              ) : holesLoading ? (
                <p style={{ color: '#6B7775', fontSize: 13.5, margin: 0 }}>Loading…</p>
              ) : (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
                    {holes.map((h) => (
                      <button
                        key={h.holeNumber}
                        onClick={() => setSelectedHole(h.holeNumber)}
                        style={{
                          width: 34, height: 34, borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit',
                          border: selectedHole === h.holeNumber ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                          background: selectedHole === h.holeNumber ? '#1B6B3A' : h.shapeTags.length ? '#E7F1EA' : '#fff',
                          color: selectedHole === h.holeNumber ? '#fff' : '#1A1F1C',
                        }}
                      >
                        {h.holeNumber}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }} className="tc-two-col">
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#6B7775', textTransform: 'uppercase' }}>Hole {selectedHole} — layout &amp; shape</label>
                        {saveNote && <span style={{ fontSize: 12, color: '#1B6B3A', fontWeight: 600 }}>{saveNote}</span>}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {HOLE_SHAPE_TAGS.map((tag) => {
                          const active = holes[selectedHole - 1].shapeTags.includes(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => toggleShapeTag(tag)}
                              style={{
                                borderRadius: 20, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                                border: active ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                                background: active ? '#E7F1EA' : '#fff', color: active ? '#1B6B3A' : '#1A1F1C',
                              }}
                            >
                              {HOLE_SHAPE_TAG_LABELS[tag]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <HoleSchematic hole={holes[selectedHole - 1]} maxWidth={220} />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
