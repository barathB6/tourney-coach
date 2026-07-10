'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';
import FormattableTextarea from '@/components/FormattableTextarea';
import { renderRichText } from '@/lib/richtext/render';

const STEPS = [
  {
    title: 'The origin & impact',
    subtitle: "Who's behind this, who is helped, and what is the need?",
    fields: [
      { key: 'founder_connection', label: "Who is the founder/organizer, and what's the connection?", placeholder: "e.g., Our school opened with 36 students and our son was one of them. Six years later, the school is full — and there's a waiting list of families who want in but can't cover tuition.", hint: 'Your personal tie to this cause — why you started or run this event.' },
      { key: 'who_helped', label: 'Who is helped?', placeholder: "e.g., Students at St. Michael's Catholic School", hint: 'The students, families, or community this tournament supports.' },
      { key: 'need', label: 'What is the need?', placeholder: "e.g., Without this funding, roughly 40% of enrolled families would need to leave within two years.", hint: 'What gap or problem does this funding actually close?' },
    ],
  },
  {
    title: 'The ask',
    subtitle: 'What does success look like, and why now?',
    fields: [
      { key: 'success_looks_like', label: 'What does success look like?', placeholder: 'e.g., This year we want to fund tuition for 20 students, up from 14 last year.', hint: 'A concrete outcome donors can rally behind.' },
      { key: 'why_now', label: 'Why now?', placeholder: 'e.g., The waiting list doubled this year, and tuition costs rose 8% — the gap is wider than it has ever been.', hint: "What makes this year's ask urgent." },
      { key: 'stat_amount', label: 'A number that brings it home', placeholder: 'e.g., 340', hint: 'A specific stat beats "many" or "a lot" every time.', input: 'number' as const },
      { key: 'stat_description', label: 'What does that number mean?', placeholder: 'e.g., Average tuition gap covered per foursome registration', hint: 'One short line — appears under the number.', input: 'line' as const },
    ],
  },
];

type PhotoRec = { type: string; reason: string };

// Step order: 0..STEPS.length-1 = prompts, STEPS.length = full story, STEPS.length+1 = length variants
const STORY_STEP = STEPS.length;
const LENGTHS_STEP = STEPS.length + 1;
const TOTAL_STEPS = STEPS.length + 2;

export default function CauseStoryBuilder() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [userId, setUserId] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<string | null>(null);

  const [fullStory, setFullStory] = useState('');
  const [prevFullStory, setPrevFullStory] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [medium, setMedium] = useState('');
  const [short, setShort] = useState('');
  const [oneLiner, setOneLiner] = useState('');
  const [generatingLengths, setGeneratingLengths] = useState(false);
  const [photoRecs, setPhotoRecs] = useState<PhotoRec[]>([]);
  const [generatingPhotos, setGeneratingPhotos] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);

      const { data: tournament } = await supabase
        .from('tournaments')
        .select('id, cause_story_answers, cause_story_full, cause_story_medium, cause_story_short, cause_story_one_liner, cause_story_photo_recs')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (tournament) {
        setTournamentId(tournament.id);
        if (tournament.cause_story_full) setFullStory(tournament.cause_story_full);
        if (tournament.cause_story_medium) setMedium(tournament.cause_story_medium);
        if (tournament.cause_story_short) setShort(tournament.cause_story_short);
        if (tournament.cause_story_one_liner) setOneLiner(tournament.cause_story_one_liner);
        if (tournament.cause_story_photo_recs) setPhotoRecs(tournament.cause_story_photo_recs);
      }

      if (tournament?.cause_story_answers) {
        // Saved answers already on the tournament record take priority over
        // a stale local draft.
        setFields((prev) => ({ ...prev, ...tournament.cause_story_answers }));
      } else {
        // Resume a previously saved local draft instead of starting blank —
        // the dashboard's "Cause story" card links here expecting exactly this.
        try {
          const saved = localStorage.getItem(`tourney_story_${user.id}`);
          if (saved) setFields(JSON.parse(saved));
        } catch { /* corrupt or missing draft — start blank */ }
      }
    });
  }, []);

  const update = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const isPromptStep = step < STEPS.length;
  const currentStep = STEPS[step];

  const buildPreview = () => {
    // Two flowing paragraphs: context (who's helped + the need), then the ask (success + why now).
    const paragraph1 = [fields.who_helped && `This tournament exists for ${fields.who_helped}.`, fields.need].filter(Boolean).join(' ');
    const paragraph2 = [fields.success_looks_like, fields.why_now].filter(Boolean).join(' ');
    const body = [paragraph1, paragraph2].filter(Boolean);
    const statAmount = fields.stat_amount?.trim();
    const statDescription = fields.stat_description?.trim();
    return { headline: fields.founder_connection, body, statAmount, statDescription };
  };

  const preview = buildPreview();
  const hasContent = Object.values(fields).some((v) => v.trim());

  const advanceToStory = () => {
    if (userId) localStorage.setItem(`tourney_story_${userId}`, JSON.stringify(fields));
    if (!fullStory) setFullStory([preview.headline, ...preview.body].filter(Boolean).join('\n\n'));
    setStep(STORY_STEP);
  };

  const handleRefine = async () => {
    if (!fullStory.trim()) { setError('Write your story first.'); return; }
    setRefining(true);
    setError('');
    try {
      const res = await fetch('/api/cause-story/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: fullStory }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI refinement failed');
      setPrevFullStory(fullStory);
      setFullStory(data.suggestion);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI refinement failed');
    } finally {
      setRefining(false);
    }
  };

  const undoRefine = () => {
    if (prevFullStory === null) return;
    setFullStory(prevFullStory);
    setPrevFullStory(null);
  };

  const handleGenerateLengths = async () => {
    if (!fullStory.trim()) { setError('Write your story first.'); return; }
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
    if (!fullStory.trim()) { setError('Write your story first.'); return; }
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

  const handleFinish = async () => {
    if (userId) localStorage.setItem(`tourney_story_${userId}`, JSON.stringify(fields));

    if (tournamentId) {
      setSaving(true);
      setError('');
      const res = await fetch(`/api/tournaments/${tournamentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cause_story_answers: fields,
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
        setError(data.error || (data.errors && data.errors[0]?.message) || 'Failed to save your story');
        return;
      }
    }

    router.push('/dashboard');
  };

  const progressBar = (
    <div className="flex gap-2 mb-6">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div key={i} className="flex-1 h-1 rounded-full" style={{ background: i <= step ? 'var(--primary)' : 'var(--line)' }} />
      ))}
    </div>
  );

  // ── STEP 3: Your full cause story ──
  if (step === STORY_STEP) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--cream)' }}>
        <div className="max-w-2xl mx-auto p-6 sm:p-10 md:p-16">
          {progressBar}

          <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--primary)' }}>
            Step {step + 1} of {TOTAL_STEPS}
          </p>
          <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: 'var(--deep-green)' }}>
            Your full cause story
          </h1>
          <p className="text-sm mb-5" style={{ color: '#596057' }}>
            This is what appears on your microsite. Edit it directly, or hover for AI refinement.
          </p>

          <div className="group relative">
            <FormattableTextarea
              value={fullStory}
              onChange={setFullStory}
              rows={6}
              placeholder="Your composed story appears here — edit freely."
              className="w-full px-3 py-2 rounded-lg outline-none resize-none text-sm leading-relaxed"
              style={{ border: '1px solid var(--line)' }}
            />
            <button
              onClick={handleRefine}
              disabled={refining}
              className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity px-3 py-1.5 rounded-full text-xs font-semibold shadow-sm"
              style={{ background: 'var(--primary)', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              {refining ? 'Refining…' : '✨ Refine with AI'}
            </button>
          </div>
          {prevFullStory !== null && (
            <button onClick={undoRefine} className="text-xs font-medium mt-1.5" style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Undo AI refinement
            </button>
          )}

          <div className="mt-10">
            <h2 className="text-lg mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: 'var(--deep-green)' }}>Photo recommendations</h2>
            <p className="text-sm mb-3" style={{ color: '#596057' }}>What kinds of photos would make your microsite land, based on your story.</p>
            <button onClick={handleGeneratePhotos} disabled={generatingPhotos}
              className="px-4 py-2 text-sm font-medium rounded-lg mb-4" style={{ color: 'var(--primary)', background: 'white', border: '1px solid var(--primary)', cursor: 'pointer' }}>
              {generatingPhotos ? 'Thinking…' : 'Get photo suggestions'}
            </button>
            {photoRecs.length > 0 && (
              <div className="space-y-2">
                {photoRecs.map((rec, i) => (
                  <div key={i} className="rounded-lg p-3" style={{ background: '#F0F4F2' }}>
                    <p className="text-sm font-bold" style={{ color: 'var(--primary)' }}>{rec.type}</p>
                    <p className="text-sm" style={{ color: '#596057' }}>{rec.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-sm mt-6" style={{ color: '#B8442C' }}>{error}</p>}

          <div className="mt-8 flex justify-between">
            <button onClick={() => setStep(STEPS.length - 1)}
              className="px-5 py-2.5 text-sm font-medium rounded-lg transition-colors" style={{ color: 'var(--ink)', background: 'white', border: '1px solid var(--line)' }}>
              ← Back
            </button>
            <button onClick={() => setStep(LENGTHS_STEP)}
              className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors" style={{ background: 'linear-gradient(180deg, var(--primary), var(--deep-green))' }}>
              Continue →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── STEP 4: Length variants ──
  if (step === LENGTHS_STEP) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--cream)' }}>
        <div className="flex flex-col md:flex-row min-h-screen">

          {/* LEFT — Variant inputs */}
          <div className="flex-1 p-6 sm:p-10 md:p-12 lg:p-16 lg:pr-12">
            <div className="max-w-xl mx-auto">
              {progressBar}

              <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--primary)' }}>
                Step {step + 1} of {TOTAL_STEPS} · Length variants
              </p>
              <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: 'var(--deep-green)' }}>
                One story, three lengths
              </h1>
              <p className="text-sm mb-5" style={{ color: '#596057' }}>
                Used across sponsor packages, social captions, and the registration form.
              </p>

              <button onClick={handleGenerateLengths} disabled={generatingLengths}
                className="px-4 py-2 text-sm font-medium rounded-lg mb-5" style={{ color: 'var(--primary)', background: 'white', border: '1px solid var(--primary)', cursor: 'pointer' }}>
                {generatingLengths ? 'Generating…' : 'Generate from full cause story'}
              </button>

              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>Medium — sponsor packages</label>
                  <FormattableTextarea value={medium} onChange={setMedium} rows={2}
                    className="w-full px-3 py-2 rounded-lg outline-none resize-none text-sm leading-relaxed" style={{ border: '1px solid var(--line)' }} />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>Short — social captions</label>
                  <FormattableTextarea value={short} onChange={setShort} rows={2}
                    className="w-full px-3 py-2 rounded-lg outline-none resize-none text-sm leading-relaxed" style={{ border: '1px solid var(--line)' }} />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>One-liner — registration form</label>
                  <input type="text" value={oneLiner} onChange={(e) => setOneLiner(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg outline-none text-sm" style={{ border: '1px solid var(--line)' }} />
                </div>
              </div>

              {error && <p className="text-sm mt-4" style={{ color: '#B8442C' }}>{error}</p>}

              <div className="mt-8 flex justify-between">
                <button onClick={() => setStep(STORY_STEP)}
                  className="px-5 py-2.5 text-sm font-medium rounded-lg transition-colors" style={{ color: 'var(--ink)', background: 'white', border: '1px solid var(--line)' }}>
                  ← Back
                </button>
                <button onClick={handleFinish} disabled={saving}
                  className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors" style={{ background: 'linear-gradient(180deg, var(--primary), var(--deep-green))' }}>
                  {saving ? 'Saving…' : 'Save & Continue to Setup →'}
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT — smaller green preview, one card per variant */}
          <div className="flex-1 p-6 sm:p-10 md:p-12 flex items-start justify-center relative overflow-hidden" style={{ background: 'var(--deep-green)' }}>
            <div className="max-w-md w-full md:sticky md:top-10 relative z-10">
              <span className="inline-block text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded mb-6" style={{ color: 'var(--deep-green)', background: 'var(--gold)', border: '1px solid var(--gold)' }}>
                Live preview
              </span>

              <div className="space-y-4">
                <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'rgba(255,255,255,0.55)' }}>Sponsor package preview</p>
                  <p className="text-sm leading-relaxed" style={{ color: 'rgba(250,248,243,0.9)', fontStyle: medium.trim() ? 'italic' : 'normal' }}>
                    {medium.trim() ? `“${medium}”` : 'Generate or write a medium version to preview it here.'}
                  </p>
                </div>

                <div className="rounded-xl p-4 flex gap-2.5 items-start" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}>
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0" style={{ background: 'var(--gold)', color: 'var(--deep-green)' }}>TC</div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.55)' }}>Social caption preview</p>
                    <p className="text-sm leading-snug" style={{ color: 'rgba(250,248,243,0.9)' }}>
                      {short.trim() || 'Generate or write a short version to preview it here.'}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'rgba(255,255,255,0.55)' }}>Registration hero preview</p>
                  <p className="text-sm" style={{ color: 'rgba(250,248,243,0.9)', fontStyle: oneLiner.trim() ? 'italic' : 'normal' }}>
                    {oneLiner.trim() || 'Write a one-liner to preview it here.'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── STEPS 1–2: Prompts ──
  return (
    <div className="min-h-screen" style={{ background: 'var(--cream)' }}>
      <div className="flex flex-col md:flex-row min-h-screen">

        {/* LEFT — Prompts */}
        <div className="flex-1 p-6 sm:p-10 md:p-12 lg:p-16 lg:pr-12">
          <div className="max-w-xl mx-auto">
            {progressBar}

            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--primary)' }}>
              Step {step + 1} of {TOTAL_STEPS} · {currentStep.title}
            </p>
            <h1 className="text-2xl mb-6" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: 'var(--deep-green)' }}>{currentStep.subtitle}</h1>

            <div className="space-y-5">
              {currentStep.fields.map((f) => (
                <div key={f.key}>
                  <label className="block text-sm font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>{f.label}</label>
                  {'input' in f && f.input === 'number' ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>$</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={fields[f.key] || ''}
                        onChange={(e) => update(f.key, e.target.value.replace(/[^0-9,]/g, ''))}
                        placeholder={f.placeholder}
                        className="w-full px-3 py-2 rounded-lg focus:ring-2 focus:ring-[var(--primary)] focus:border-transparent outline-none text-sm"
                        style={{ border: '1px solid var(--line)' }}
                      />
                    </div>
                  ) : 'input' in f && f.input === 'line' ? (
                    <input
                      type="text"
                      value={fields[f.key] || ''}
                      onChange={(e) => update(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full px-3 py-2 rounded-lg focus:ring-2 focus:ring-[var(--primary)] focus:border-transparent outline-none text-sm"
                      style={{ border: '1px solid var(--line)' }}
                    />
                  ) : (
                    <FormattableTextarea
                      value={fields[f.key] || ''}
                      onChange={(v) => update(f.key, v)}
                      placeholder={f.placeholder}
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg focus:ring-2 focus:ring-[var(--primary)] focus:border-transparent outline-none resize-none text-sm leading-relaxed" style={{ border: '1px solid var(--line)' }}
                    />
                  )}
                  <p className="text-xs mt-1" style={{ color: '#596057' }}>{f.hint}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex justify-between">
              {step > 0 ? (
                <button onClick={() => setStep(step - 1)}
                  className="px-5 py-2.5 text-sm font-medium rounded-lg transition-colors" style={{ color: 'var(--ink)', background: 'white', border: '1px solid var(--line)' }}>
                  ← Back
                </button>
              ) : <div />}
              {step < STEPS.length - 1 ? (
                <button onClick={() => setStep(step + 1)}
                  className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors" style={{ background: 'linear-gradient(180deg, var(--primary), var(--deep-green))' }}>
                  Continue →
                </button>
              ) : (
                <button onClick={advanceToStory}
                  className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors" style={{ background: 'linear-gradient(180deg, var(--primary), var(--deep-green))' }}>
                  Continue →
                </button>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — Live Donor Preview (dark green) */}
        <div className="flex-1 p-6 sm:p-10 md:p-12 flex items-start justify-center relative overflow-hidden" style={{ background: 'var(--deep-green)' }}>
          <div className="absolute top-0 right-0 w-[400px] h-[400px] rounded-full translate-x-1/3 -translate-y-1/3" style={{ border: '1px solid rgba(27,107,58,0.2)' }} />
          <div className="absolute top-0 right-0 w-[300px] h-[300px] rounded-full translate-x-1/4 -translate-y-1/4" style={{ border: '1px solid rgba(27,107,58,0.15)' }} />
          <div className="max-w-md w-full md:sticky md:top-10 relative z-10">
            <span className="inline-block text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded mb-6" style={{ color: 'var(--deep-green)', background: 'var(--gold)', border: '1px solid var(--gold)' }}>
              Live Donor View
            </span>

            {!hasContent ? (
              <p className="text-sm mt-8" style={{ color: 'rgba(27,107,58,0.7)' }}>Start writing on the left — your donor story will appear here in real time.</p>
            ) : (
              <div className="space-y-5">
                {preview.headline && (
                  <h2 className="text-2xl sm:text-3xl text-white leading-tight" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>
                    {renderRichText(preview.headline)}
                  </h2>
                )}
                {preview.body.map((p, i) => (
                  <div key={i} className="text-sm leading-relaxed" style={{ color: 'rgba(250,248,243,0.85)' }}>{renderRichText(p)}</div>
                ))}
                {(preview.statAmount || preview.statDescription) && (
                  <div className="rounded-2xl p-6 mt-2" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}>
                    {preview.statAmount && (
                      <p className="text-4xl sm:text-5xl font-bold" style={{ color: 'var(--gold)', fontFamily: "'Fraunces', serif" }}>${preview.statAmount}</p>
                    )}
                    {preview.statDescription && (
                      <p className="text-base mt-2" style={{ color: 'rgba(250,248,243,0.85)' }}>{preview.statDescription}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
