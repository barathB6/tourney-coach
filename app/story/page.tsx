'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v.trim()) params.set(k, v.trim());
    }
    router.push(`/setup?${params.toString()}`);
  };

  // Extract dollar amount from stat for display
  const statAmount = preview.stat?.match(/\$[\d,]+/)?.[0];
  const statDesc = preview.stat?.replace(/\$[\d,]+\s*[-—]?\s*/, '');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row min-h-screen">

        {/* LEFT — Prompts */}
        <div className="flex-1 p-6 sm:p-10 lg:pr-8">
          <div className="max-w-xl">
            {/* Step progress bars */}
            <div className="flex gap-2 mb-6">
              {STEPS.map((_, i) => (
                <div key={i} className={`flex-1 h-1 rounded-full ${i <= step ? 'bg-green-800' : 'bg-gray-300'}`} />
              ))}
            </div>

            <p className="text-xs font-semibold text-green-800 uppercase tracking-wider mb-1">
              Step {step + 1} of {STEPS.length} · {currentStep.title}
            </p>
            <h1 className="text-2xl font-bold text-gray-900 mb-6">{currentStep.subtitle}</h1>

            <div className="space-y-5">
              {currentStep.fields.map((f) => (
                <div key={f.key}>
                  <label className="block text-sm font-semibold text-gray-900 mb-1.5">{f.label}</label>
                  {f.key === 'impactNumber' || f.key === 'askHook' || f.key === 'askGoal' ? (
                    <input
                      type="text"
                      value={fields[f.key] || ''}
                      onChange={(e) => update(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm"
                    />
                  ) : (
                    <textarea
                      value={fields[f.key] || ''}
                      onChange={(e) => update(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={3}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none resize-none text-sm leading-relaxed"
                    />
                  )}
                  <p className="text-xs text-gray-400 mt-1">{f.hint}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex justify-between">
              {step > 0 ? (
                <button onClick={() => setStep(step - 1)}
                  className="px-5 py-2.5 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                  ← Back
                </button>
              ) : <div />}
              {step < STEPS.length - 1 ? (
                <button onClick={() => setStep(step + 1)}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-green-800 rounded-lg hover:bg-green-900 transition-colors">
                  Continue →
                </button>
              ) : (
                <button onClick={handleFinish}
                  className="px-5 py-2.5 text-sm font-medium text-white bg-green-800 rounded-lg hover:bg-green-900 transition-colors">
                  Save & Continue to Setup →
                </button>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT — Live Donor Preview (dark green) */}
        <div className="flex-1 bg-[#1a3a2a] p-6 sm:p-10 flex items-start justify-center">
          <div className="max-w-md w-full lg:sticky lg:top-10">
            <span className="inline-block text-[10px] font-bold text-green-300 uppercase tracking-widest bg-green-900/50 px-3 py-1 rounded mb-6">
              Live Donor View
            </span>

            {!hasContent ? (
              <p className="text-green-600 text-sm mt-8">Start writing on the left — your donor story will appear here in real time.</p>
            ) : (
              <div className="space-y-5">
                {preview.hook && (
                  <h2 className="text-2xl sm:text-3xl font-bold text-white leading-tight">{preview.hook}</h2>
                )}
                {preview.org && !preview.hook && (
                  <h2 className="text-2xl font-bold text-white">{preview.org}</h2>
                )}
                {preview.paragraphs.map((p, i) => (
                  <p key={i} className="text-sm text-green-100/80 leading-relaxed">{p}</p>
                ))}
                {preview.stat && (
                  <div className="bg-green-900/60 border border-green-700/30 rounded-lg p-5 mt-6">
                    {statAmount && (
                      <p className="text-2xl font-bold text-amber-400">{statAmount}</p>
                    )}
                    {statDesc && (
                      <p className="text-sm text-green-200/70 mt-1">{statDesc}</p>
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
