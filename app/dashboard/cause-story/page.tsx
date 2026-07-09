'use client';

import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Answers = {
  who_helped: string;
  need: string;
  success_looks_like: string;
  why_now: string;
  founder_connection: string;
};

type PhotoRec = { type: string; reason: string };

type Tournament = {
  id: string;
  name: string;
  cause_story: string | null;
  cause_story_answers: Answers | null;
  cause_story_full: string | null;
  cause_story_medium: string | null;
  cause_story_short: string | null;
  cause_story_one_liner: string | null;
  cause_story_photo_recs: PhotoRec[] | null;
};

const EMPTY_ANSWERS: Answers = {
  who_helped: '',
  need: '',
  success_looks_like: '',
  why_now: '',
  founder_connection: '',
};

const PROMPTS: { key: keyof Answers; label: string; placeholder: string }[] = [
  { key: 'who_helped', label: 'Who is helped?', placeholder: 'The students, families, or community this tournament supports…' },
  { key: 'need', label: 'What is the need?', placeholder: 'What gap or problem does this funding actually close?' },
  { key: 'success_looks_like', label: 'What does success look like?', placeholder: 'A concrete outcome — a scholarship funded, a program running for another year…' },
  { key: 'why_now', label: 'Why now?', placeholder: 'What makes this year urgent or timely?' },
  { key: 'founder_connection', label: 'Who is the founder/organizer, and what\'s the connection?', placeholder: 'Your personal tie to this cause — why you started or run this event.' },
];

export default function CauseStoryPage() {
  const router = useRouter();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [fullStory, setFullStory] = useState('');
  const [aiSuggestion, setAiSuggestion] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineNote, setRefineNote] = useState('');
  const [medium, setMedium] = useState('');
  const [short, setShort] = useState('');
  const [oneLiner, setOneLiner] = useState('');
  const [generatingLengths, setGeneratingLengths] = useState(false);
  const [photoRecs, setPhotoRecs] = useState<PhotoRec[]>([]);
  const [generatingPhotos, setGeneratingPhotos] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(async (response) => {
      const user = response.data.user;
      if (!user) { router.replace('/sign-in?next=/dashboard/cause-story'); return; }

      const { data } = await supabase
        .from('tournaments')
        .select('id, name, cause_story, cause_story_answers, cause_story_full, cause_story_medium, cause_story_short, cause_story_one_liner, cause_story_photo_recs')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data) {
        setTournament(data as Tournament);
        setAnswers((data.cause_story_answers as Answers) ?? EMPTY_ANSWERS);
        setFullStory(data.cause_story_full ?? data.cause_story ?? '');
        setMedium(data.cause_story_medium ?? '');
        setShort(data.cause_story_short ?? '');
        setOneLiner(data.cause_story_one_liner ?? '');
        setPhotoRecs((data.cause_story_photo_recs as PhotoRec[]) ?? []);
      }
    });
  }, []);

  const setAnswer = (key: keyof Answers, value: string) =>
    setAnswers(a => ({ ...a, [key]: value }));

  const composeDraft = () => {
    const parts = [
      answers.who_helped && `This tournament exists for ${answers.who_helped}.`,
      answers.need && answers.need,
      answers.success_looks_like && `Success looks like: ${answers.success_looks_like}.`,
      answers.why_now && answers.why_now,
      answers.founder_connection && answers.founder_connection,
    ].filter(Boolean);
    setFullStory(parts.join('\n\n'));
    setStep(2);
  };

  const handleRefine = async () => {
    if (!fullStory.trim()) { setError('Write a draft first.'); return; }
    setRefining(true);
    setError('');
    try {
      const res = await fetch('/api/cause-story/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: fullStory, instruction: refineNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI refinement failed');
      setAiSuggestion(data.suggestion);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI refinement failed');
    } finally {
      setRefining(false);
    }
  };

  const acceptSuggestion = () => {
    setFullStory(aiSuggestion);
    setAiSuggestion('');
  };

  const handleGenerateLengths = async () => {
    if (!fullStory.trim()) { setError('Write your full story first.'); return; }
    setGeneratingLengths(true);
    setError('');
    try {
      const res = await fetch('/api/cause-story/lengths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullStory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI length generation failed');
      setMedium(data.medium);
      setShort(data.short);
      setOneLiner(data.oneLiner);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI length generation failed');
    } finally {
      setGeneratingLengths(false);
    }
  };

  const handleGeneratePhotos = async () => {
    if (!fullStory.trim()) { setError('Write your full story first.'); return; }
    setGeneratingPhotos(true);
    setError('');
    try {
      const res = await fetch('/api/cause-story/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullStory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI photo recommendations failed');
      setPhotoRecs(data.recommendations);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI photo recommendations failed');
    } finally {
      setGeneratingPhotos(false);
    }
  };

  const handleSave = async () => {
    if (!tournament) return;
    setSaving(true);
    setError('');
    setSaved(false);

    const res = await fetch(`/api/tournaments/${tournament.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cause_story_answers: answers,
        cause_story_full: fullStory || null,
        cause_story_medium: medium || null,
        cause_story_short: short || null,
        cause_story_one_liner: oneLiner || null,
        cause_story_photo_recs: photoRecs,
      }),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || (data.errors && data.errors[0]?.message) || 'Failed to save');
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const s = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' } as React.CSSProperties,
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 8, padding: '28px', marginBottom: 20 } as React.CSSProperties,
    label: { display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#6B7775', marginBottom: 6 },
    hint: { fontSize: 12, color: '#9BA8A4', marginTop: 4 },
    input: { width: '100%', padding: '10px 12px', border: '1px solid #E5E0D5', borderRadius: 4, fontSize: 15, background: '#FAFAF8', boxSizing: 'border-box' as const },
    textarea: { width: '100%', padding: '10px 12px', border: '1px solid #E5E0D5', borderRadius: 4, fontSize: 15, background: '#FAFAF8', boxSizing: 'border-box' as const, minHeight: 90, resize: 'vertical' as const, fontFamily: "'DM Sans', sans-serif" },
    btn: { padding: '12px 28px', background: '#1B6B3A', color: '#fff', fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 4, cursor: 'pointer' },
    btnSecondary: { padding: '10px 20px', background: '#fff', color: '#1B6B3A', fontWeight: 700, fontSize: 14, border: '1px solid #1B6B3A', borderRadius: 4, cursor: 'pointer' },
    row: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
    stepPill: (active: boolean, done: boolean) => ({
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 20,
      background: active ? '#1B6B3A' : done ? '#E9F2EC' : '#F0F0EC',
      color: active ? '#fff' : done ? '#1B6B3A' : '#9BA8A4',
      fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none',
    }),
  };

  if (!tournament) return (
    <div style={{ ...s.page, textAlign: 'center', paddingTop: 80 }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  const steps = [
    { n: 1, label: 'Prompts' },
    { n: 2, label: 'Draft & Refine' },
    { n: 3, label: 'Length Variants' },
    { n: 4, label: 'Photos' },
  ];

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ marginBottom: 24 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
            ← Back to dashboard
          </button>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Cause Story Builder</h1>
          <p style={{ color: '#6B7775', margin: '4px 0 0', fontSize: 14 }}>{tournament.name}</p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
          {steps.map(st => (
            <button key={st.n} style={s.stepPill(step === st.n, step > st.n)} onClick={() => setStep(st.n)}>
              {st.n}. {st.label}
            </button>
          ))}
        </div>

        {error && <p style={{ color: '#B8442C', fontSize: 14, marginBottom: 12 }}>{error}</p>}

        {step === 1 && (
          <div style={s.card}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 4, marginTop: 0 }}>Structured Prompts</h2>
            <p style={{ fontSize: 13, color: '#6B7775', margin: '0 0 20px' }}>
              Answer these five questions in your own words — they become the backbone of your cause story.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {PROMPTS.map(p => (
                <div key={p.key} style={s.row}>
                  <label style={s.label}>{p.label}</label>
                  <textarea style={s.textarea} value={answers[p.key]} onChange={e => setAnswer(p.key, e.target.value)} placeholder={p.placeholder} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 24 }}>
              <button style={s.btn} onClick={composeDraft}>Continue to Draft →</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={s.card}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 4, marginTop: 0 }}>Your Draft</h2>
            <p style={{ fontSize: 13, color: '#6B7775', margin: '0 0 16px' }}>
              This is your full cause story — it appears on your microsite. Write it in your own voice; AI can suggest improvements without replacing it.
            </p>
            <textarea style={{ ...s.textarea, minHeight: 220 }} value={fullStory} onChange={e => setFullStory(e.target.value)} placeholder="Tell the story of why this tournament exists…" />

            <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input style={{ ...s.input, flex: 1, minWidth: 200 }} value={refineNote} onChange={e => setRefineNote(e.target.value)}
                placeholder="Optional: tell the AI what to focus on (e.g. 'make it warmer')" />
              <button style={s.btnSecondary} onClick={handleRefine} disabled={refining}>
                {refining ? 'Thinking…' : 'Ask AI to refine'}
              </button>
            </div>

            {aiSuggestion && (
              <div style={{ marginTop: 20, background: '#F0F4F2', border: '1px solid #C9DED0', borderRadius: 6, padding: 16 }}>
                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#1B6B3A', margin: '0 0 8px' }}>AI suggestion</p>
                <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: '0 0 12px' }}>{aiSuggestion}</p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button style={s.btn} onClick={acceptSuggestion}>Use this version</button>
                  <button style={s.btnSecondary} onClick={() => setAiSuggestion('')}>Discard</button>
                </div>
              </div>
            )}

            <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
              <button style={s.btnSecondary} onClick={() => setStep(1)}>← Back</button>
              <button style={s.btn} onClick={() => setStep(3)}>Continue to Lengths →</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={s.card}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 4, marginTop: 0 }}>Length Variants</h2>
            <p style={{ fontSize: 13, color: '#6B7775', margin: '0 0 16px' }}>
              Generate shorter versions of your story for use across the platform, then edit as needed.
            </p>
            <button style={s.btnSecondary} onClick={handleGenerateLengths} disabled={generatingLengths}>
              {generatingLengths ? 'Generating…' : 'Generate from full story'}
            </button>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 20 }}>
              <div style={s.row}>
                <label style={s.label}>Medium — sponsor packages (~40-60 words)</label>
                <textarea style={s.textarea} value={medium} onChange={e => setMedium(e.target.value)} placeholder="Generated after you click above, or write your own." />
              </div>
              <div style={s.row}>
                <label style={s.label}>Short — social captions (~20-30 words)</label>
                <textarea style={{ ...s.textarea, minHeight: 60 }} value={short} onChange={e => setShort(e.target.value)} />
              </div>
              <div style={s.row}>
                <label style={s.label}>One-liner — registration form header (under 15 words)</label>
                <input style={s.input} value={oneLiner} onChange={e => setOneLiner(e.target.value)} />
              </div>
            </div>

            <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
              <button style={s.btnSecondary} onClick={() => setStep(2)}>← Back</button>
              <button style={s.btn} onClick={() => setStep(4)}>Continue to Photos →</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={s.card}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 4, marginTop: 0 }}>Photo Recommendations</h2>
            <p style={{ fontSize: 13, color: '#6B7775', margin: '0 0 16px' }}>
              Based on your story, here's what kinds of photos would make your microsite land.
            </p>
            <button style={s.btnSecondary} onClick={handleGeneratePhotos} disabled={generatingPhotos}>
              {generatingPhotos ? 'Thinking…' : 'Get photo suggestions'}
            </button>

            {photoRecs.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
                {photoRecs.map((rec, i) => (
                  <div key={i} style={{ background: '#F0F4F2', borderRadius: 6, padding: '12px 16px' }}>
                    <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 14, color: '#1B6B3A' }}>{rec.type}</p>
                    <p style={{ margin: 0, fontSize: 13, color: '#6B7775' }}>{rec.reason}</p>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 24, display: 'flex', gap: 10 }}>
              <button style={s.btnSecondary} onClick={() => setStep(3)}>← Back</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 48, marginTop: 8 }}>
          <button style={s.btn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Cause Story'}
          </button>
          {saved && <p style={{ color: '#1B6B3A', fontSize: 14, margin: 0 }}>Saved</p>}
        </div>
      </div>
    </div>
  );
}
