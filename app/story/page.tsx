'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';
import FormattableTextarea from '@/components/FormattableTextarea';
import { renderRichText, renderInline } from '@/lib/richtext/render';

const STEPS = [
  {
    title: 'The origin',
    subtitle: 'Why does this tournament exist?',
    fields: [
      { key: 'orgName', label: 'What is the name of your organization or cause?', placeholder: "e.g., St. Michael's Catholic School", hint: 'The official name donors will see.' },
      { key: 'originStory', label: 'Why did you start this tournament?', placeholder: "e.g., Our school opened with 36 students and our son was one of them. Six years later, the school is full — and there's a waiting list of families who want in but can't cover tuition.", hint: 'Tell the founding moment. Personal beats polished.' },
    ],
  },
  {
    title: 'The mission',
    subtitle: 'What does the money actually do?',
    fields: [
      { key: 'missionWhat', label: 'Where does every dollar go?', placeholder: "e.g., Funds tuition assistance for families who couldn't otherwise afford a Catholic education.", hint: 'One sentence. Be specific about the use of funds.' },
      { key: 'missionHow', label: 'How does golf make this possible?', placeholder: 'e.g., A single foursome registration covers the average tuition gap for one student for a full semester.', hint: 'Connect the game to the giving.' },
    ],
  },
  {
    title: 'The specific impact',
    subtitle: 'Who, exactly, does this help — and how?',
    fields: [
      { key: 'impactWho', label: 'Whose life does this change?', placeholder: "e.g., Students at St. Michael's Catholic School", hint: 'Be concrete. Not "kids in our community" — name the specific group.' },
      { key: 'impactWhat', label: 'What specifically does the money do?', placeholder: "e.g., Funds tuition assistance for families who couldn't otherwise afford a Catholic education. Last year's tournament covered partial tuition for 14 students.", hint: "Show, don't tell." },
      { key: 'impactNumber', label: 'A number that brings it home', placeholder: 'e.g., 14 students received tuition help last year', hint: 'A specific count beats "many" or "dozens" every time.' },
    ],
  },
  {
    title: 'The ask',
    subtitle: 'What happens when someone signs up?',
    fields: [
      { key: 'askHook', label: 'The one-line hook for donors', placeholder: 'e.g., When you sign up to play, fourteen kids stay in school next year.', hint: 'This appears at the top of your tournament page. Make it land.' },
      { key: 'askGoal', label: "This year's goal", placeholder: 'e.g., This year we want to make it 20.', hint: 'A concrete target donors can rally behind.' },
      { key: 'askStat', label: 'A dollar stat that connects golf to giving', placeholder: 'e.g., $340 — average tuition gap covered per foursome registration', hint: 'Show what a registration actually buys.' },
    ],
  },
];

export default function CauseStoryBuilder() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);

      // Resume a previously saved draft instead of starting blank — the
      // dashboard's "Cause story" card links here expecting exactly this.
      try {
        const saved = localStorage.getItem(`tourney_story_${user.id}`);
        if (saved) setFields(JSON.parse(saved));
      } catch { /* corrupt or missing draft — start blank */ }
    });
  }, []);

  const update = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const currentStep = STEPS[step];

  const buildPreview = () => {
    const hook = fields.askHook;
    const org = fields.orgName;
    const origin = fields.originStory;
    const mission = fields.missionWhat;
    const impact = fields.impactWhat;
    const number = fields.impactNumber;
    const goal = fields.askGoal;
    const stat = fields.askStat;
    const missionHow = fields.missionHow;

    const paragraphs: string[] = [];
    if (origin) paragraphs.push(origin);
    if (mission && impact) {
      paragraphs.push(`${mission} ${impact}`);
    } else if (mission) {
      paragraphs.push(mission);
    } else if (impact) {
      paragraphs.push(impact);
    }
    if (missionHow) paragraphs.push(missionHow);
    if (goal) paragraphs.push(goal);

    return { hook, org, paragraphs, number, stat };
  };

  const preview = buildPreview();
  const hasContent = Object.values(fields).some((v) => v.trim());

  const handleFinish = () => {
    if (userId) localStorage.setItem(`tourney_story_${userId}`, JSON.stringify(fields));
    router.push('/dashboard');
  };

  // Extract dollar amount from stat for display
  const statAmount = preview.stat?.match(/\$[\d,]+/)?.[0];
  const statDesc = preview.stat?.replace(/\$[\d,]+\s*[-—]?\s*/, '');

  return (
    <div className="min-h-screen" style={{ background: 'var(--cream)' }}>
      <div className="flex flex-col md:flex-row min-h-screen">

        {/* LEFT — Prompts */}
        <div className="flex-1 p-6 sm:p-10 md:p-12 lg:p-16 lg:pr-12">
          <div className="max-w-xl mx-auto">
            {/* Step progress bars */}
            <div className="flex gap-2 mb-6">
              {STEPS.map((_, i) => (
                <div key={i} className={`flex-1 h-1 rounded-full`} style={{ background: i <= step ? 'var(--primary)' : 'var(--line)' }} />
              ))}
            </div>

            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--primary)' }}>
              Step {step + 1} of {STEPS.length} · {currentStep.title}
            </p>
            <h1 className="text-2xl mb-6" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: 'var(--deep-green)' }}>{currentStep.subtitle}</h1>

            <div className="space-y-5">
              {currentStep.fields.map((f) => (
                <div key={f.key}>
                  <label className="block text-sm font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>{f.label}</label>
                  {f.key === 'impactNumber' || f.key === 'askHook' || f.key === 'askGoal' ? (
                    <input
                      type="text"
                      value={fields[f.key] || ''}
                      onChange={(e) => update(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full px-4 py-3 rounded-lg focus:ring-2 focus:ring-[var(--primary)] focus:border-transparent outline-none text-sm" style={{ border: '1px solid var(--line)' }}
                    />
                  ) : (
                    <FormattableTextarea
                      value={fields[f.key] || ''}
                      onChange={(v) => update(f.key, v)}
                      placeholder={f.placeholder}
                      rows={3}
                      className="w-full px-4 py-3 rounded-lg focus:ring-2 focus:ring-[var(--primary)] focus:border-transparent outline-none resize-none text-sm leading-relaxed" style={{ border: '1px solid var(--line)' }}
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
                <button onClick={handleFinish}
                  className="px-5 py-2.5 text-sm font-medium text-white rounded-lg transition-colors" style={{ background: 'linear-gradient(180deg, var(--primary), var(--deep-green))' }}>
                  Save & Continue to Setup →
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
                {preview.org && (
                  <h2 className="text-2xl sm:text-3xl text-white leading-tight" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>{renderInline(preview.org, 'org')}</h2>
                )}
                {preview.hook && (
                  <p className="text-base" style={{ color: 'rgba(250,248,243,0.85)' }}>{renderInline(preview.hook, 'hook')}</p>
                )}
                {preview.paragraphs.map((p, i) => (
                  <div key={i} className="text-sm leading-relaxed" style={{ color: 'rgba(250,248,243,0.8)' }}>{renderRichText(p)}</div>
                ))}
                {preview.stat && (
                  <div className="rounded-lg p-5 mt-6" style={{ background: 'rgba(27,107,58,0.4)', border: '1px solid rgba(27,107,58,0.3)' }}>
                    {statAmount && (
                      <p className="text-2xl font-bold" style={{ color: 'var(--gold)', fontFamily: "'Fraunces', serif" }}>{statAmount}</p>
                    )}
                    {statDesc && (
                      <p className="text-sm mt-1" style={{ color: 'rgba(250,248,243,0.6)' }}>{renderInline(statDesc, 'stat')}</p>
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
