'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import supabase from '@/lib/supabaseClient';
import type { TournamentInput } from '@/lib/tournaments';

const TOTAL_STEPS = 6;
const STEP_LABELS = ['Format', 'Field', 'Course', 'Pricing', 'Sponsors', 'Review'];

const FORMAT_OPTIONS = [
  { value: 'scramble', label: '4-Person Scramble', recommended: true, desc: 'Every player tees off, team picks the best ball, all play from there. Forgiving, fast, fun. Mixed skill levels welcome.', team: '4 per team', time: '4-4.5 hrs avg play', skill: 'Any' },
  { value: 'best_ball', label: '2-Person Best Ball', recommended: false, desc: 'Each player plays own ball, team takes the lower score per hole. Slightly more competitive, slightly slower.', team: '2 per team', time: '4.5-5 hrs avg play', skill: 'Mid+' },
  { value: 'stableford', label: 'Modified Stableford', recommended: false, desc: 'Points-based. Encourages aggressive play. Better for events where corporate teams want individual recognition.', team: '4 per team', time: '4-4.5 hrs', skill: 'Any' },
  { value: 'captains_choice', label: "Captain's Choice", recommended: false, desc: 'Same as scramble in practice. Use this name if your community knows it better — fully interchangeable.', team: '4 per team', time: '4-4.5 hrs', skill: 'Any' },
];

const MAX_SCORE_OPTIONS = [
  { value: 'par', label: 'Pick up at Par', desc: 'Teams pick up at par — saves 30-45 min, keeps energy high' },
  { value: 'double_bogey', label: 'Pick up at Double Bogey', desc: 'More lenient cutoff for experienced fields' },
  { value: 'none', label: 'No Max Score', desc: 'Play every hole out — not recommended for charity events' },
];

const SHOTGUN_OPTIONS = [
  { value: 'double', label: 'Double Shotgun', desc: 'Two waves (AM/PM) — max 128 players on par-72' },
  { value: 'single', label: 'Single Shotgun', desc: 'One wave, all groups start at once — max 72 players' },
  { value: 'wave', label: 'Wave Start', desc: 'Groups tee off in waves every 8-10 min' },
  { value: 'tee_times', label: 'Tee Times', desc: 'Standard tee time intervals — best for smaller fields' },
];

interface Course {
  id: string;
  name: string;
  city: string;
  state: string;
  tees?: string[] | null;
}

const TEE_LABELS: Record<string, string> = { black: 'Black', blue: 'Blue', white: 'White', gold: 'Gold', red: 'Red' };

export default function SetupClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [useCustomCourse, setUseCustomCourse] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    causeName: '',
    eventDate: '',
    courseId: '',
    selectedTees: [] as string[],
    customCourseName: '',
    customCourseCity: '',
    customCourseState: '',
    format: 'scramble',
    teamSize: '4',
    maxScoreRule: 'par',
    shotgunType: 'double',
    maxPlayers: '128',
    entryFee: '125',
    causeWhat: '',
    causeWho: '',
    causeWhy: '',
    causeHook: '',
    causeGoal: '',
    causeStat: '',
    causeOrigin: '',
    sponsorNotes: '',
  });

  useEffect(() => {
    const mapping: Record<string, string> = {
      orgName: 'causeName', originStory: 'causeOrigin', missionWhat: 'causeWhat',
      impactWho: 'causeWho', impactWhat: 'causeWhy', impactNumber: 'causeStat',
      askHook: 'causeHook', askGoal: 'causeGoal', askStat: 'causeStat',
    };

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.replace(`/sign-in?next=/setup/format`); return; }

      const updates: Record<string, string> = {};

      try {
        const saved = localStorage.getItem(`tourney_story_${user.id}`);
        if (saved) {
          const story = JSON.parse(saved) as Record<string, string>;
          for (const [param, field] of Object.entries(mapping)) {
            if (story[param]?.trim()) updates[field] = story[param].trim();
          }
          // Tournament Name defaults to the org/cause name from step 1 of
          // the story wizard, so organizers don't retype it — still
          // editable, and never overwrites something they've already typed.
          if (story.orgName?.trim()) updates.name = story.orgName.trim();
        }
      } catch { /* ignore */ }

      if (searchParams) {
        for (const [param, field] of Object.entries(mapping)) {
          const val = searchParams.get(param);
          if (val) updates[field] = val;
        }
      }

      if (Object.keys(updates).length > 0) {
        setFormData((prev) => ({
          ...prev,
          ...updates,
          // Only apply the name default if the organizer hasn't typed one —
          // checked here (not above) so a re-run of this effect can't stomp
          // on something they've already entered.
          name: prev.name.trim() ? prev.name : (updates.name ?? prev.name),
        }));
      }
    });

    fetchCourses();
  }, [searchParams, router]);

  const fetchCourses = async () => {
    try {
      const { data, error } = await supabase.from('courses').select('id, name, city, state, tees').order('name');
      if (error) throw error;
      setCourses(data || []);
    } catch {
      // Pre-migration fallback: tees column may not exist yet (023_course_builder).
      try {
        const { data } = await supabase.from('courses').select('id, name, city, state').order('name');
        setCourses(data || []);
      } catch { setCourses([]); }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setError(null);
  };

  const selectOption = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  const canAdvance = (): boolean => {
    switch (step) {
      case 1: return !!formData.format;
      case 2: return !!(formData.maxPlayers && formData.shotgunType);
      case 3: return !!(formData.eventDate && (formData.courseId || (useCustomCourse && formData.customCourseName)));
      case 4: return !!(formData.entryFee && formData.name);
      case 5: return true;
      default: return true;
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/sign-in?next=/setup/format');
        return;
      }
      const causeStory = [formData.causeHook, formData.causeOrigin, formData.causeWhat, formData.causeWho, formData.causeWhy, formData.causeGoal].filter(Boolean).join('\n\n') || undefined;
      const payload: TournamentInput = {
        name: formData.name,
        event_date: formData.eventDate,
        course_id: formData.courseId || undefined,
        selected_tees: formData.selectedTees.length > 0 ? formData.selectedTees : undefined,
        format: formData.format as TournamentInput['format'],
        max_score_rule: formData.maxScoreRule as TournamentInput['max_score_rule'],
        shotgun_type: formData.shotgunType as TournamentInput['shotgun_type'],
        max_players: parseInt(formData.maxPlayers),
        entry_fee_cents: parseInt(formData.entryFee) * 100,
        cause_story: causeStory,
      };
      const res = await fetch('/api/tournaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errors?.[0]?.message || data.error || 'Something went wrong');
      setSuccess('Tournament created!');
      setTimeout(() => router.push('/dashboard'), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setLoading(false); }
  };

  const prevLabel = step === 2 ? '← Back to format' : step === 3 ? '← Back to field' : step === 4 ? '← Back to course' : step === 5 ? '← Back to pricing' : step === 6 ? '← Back to sponsors' : '← Back';
  const nextLabel = step === 1 ? 'Continue to field size →' : step === 2 ? 'Continue to course →' : step === 3 ? 'Continue to pricing →' : step === 4 ? 'Continue to sponsors →' : step === 5 ? 'Continue to review →' : 'Continue →';

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-6">
      <div className="max-w-3xl mx-auto">

        {/* Circular step indicator */}
        <div className="flex items-center justify-center mb-8 px-4">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex items-center">
              <div className="flex flex-col items-center">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                  i + 1 < step ? 'bg-green-800 border-green-800 text-white'
                  : i + 1 === step ? 'bg-white border-green-800 text-green-800'
                  : 'bg-white border-gray-300 text-gray-400'
                }`}>
                  {i + 1 < step ? (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span className={`text-[10px] mt-1.5 font-medium ${i + 1 === step ? 'text-green-800' : 'text-gray-400'}`}>{label}</span>
              </div>
              {i < STEP_LABELS.length - 1 && (
                <div className={`w-8 sm:w-14 h-0.5 mx-1 mb-5 ${i + 1 < step ? 'bg-green-800' : 'bg-gray-300'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8">

          {/* STEP 1: Format — 2x2 grid */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Pick your tournament format</h2>
                <p className="text-sm text-gray-500 mt-1">For a charity tournament with mixed-skill players, scramble is almost always the right call.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {FORMAT_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button" onClick={() => { selectOption('format', opt.value); if (opt.team.startsWith('2')) selectOption('teamSize', '2'); else selectOption('teamSize', '4'); }}
                    className={`text-left px-4 py-4 rounded-lg border-2 transition-colors ${
                      formData.format === opt.value ? 'border-green-800 bg-green-50' : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-bold text-sm text-gray-900">{opt.label}</span>
                      {opt.recommended && <span className="text-[9px] font-bold text-green-800 bg-green-100 px-2 py-0.5 rounded-full whitespace-nowrap">Recommended</span>}
                    </div>
                    <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">{opt.desc}</p>
                    <div className="flex gap-3 mt-3 text-[11px]">
                      <span className="text-green-800 font-semibold">{opt.team}</span>
                      <span className="text-gray-400"><strong className="text-gray-600">{opt.time.split(' ')[0]}</strong> {opt.time.split(' ').slice(1).join(' ')}</span>
                      <span className="text-gray-400">Skill: <strong className="text-gray-600">{opt.skill}</strong></span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="bg-[#1a3a2a] rounded-lg p-4">
                <p className="text-sm text-green-100 leading-relaxed">
                  <strong className="text-white">Coach's note</strong> — for first-year tournaments, we strongly recommend scramble with a "par is your friend" max-score rule. Players pick up at par. Saves 30-45 minutes of round time and prevents weekend players from grinding out an 8.
                </p>
              </div>
            </div>
          )}

          {/* STEP 2: Field Size */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Field size & start method</h2>
                <p className="text-sm text-gray-500 mt-1">How many players and how they'll tee off.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Player Count Goal</label>
                <select name="maxPlayers" value={formData.maxPlayers} onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm">
                  <option value="36">36 players (9 foursomes)</option>
                  <option value="72">72 players (18 foursomes)</option>
                  <option value="128">128 players (32 foursomes — double shotgun)</option>
                  <option value="144">144 players (36 foursomes)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Start Method</label>
                <div className="space-y-2">
                  {SHOTGUN_OPTIONS.map((opt) => (
                    <button key={opt.value} type="button" onClick={() => selectOption('shotgunType', opt.value)}
                      className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                        formData.shotgunType === opt.value ? 'border-green-800 bg-green-50' : 'border-gray-200 hover:border-gray-300'
                      }`}>
                      <div className="font-semibold text-sm text-gray-900">{opt.label}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Max Score Rule</label>
                <div className="space-y-2">
                  {MAX_SCORE_OPTIONS.map((opt) => (
                    <button key={opt.value} type="button" onClick={() => selectOption('maxScoreRule', opt.value)}
                      className={`w-full text-left px-4 py-2.5 rounded-lg border-2 transition-colors text-sm ${
                        formData.maxScoreRule === opt.value ? 'border-green-800 bg-green-50' : 'border-gray-200 hover:border-gray-300'
                      }`}>
                      <span className="font-semibold text-gray-900">{opt.label}</span>
                      <span className="text-xs text-gray-500 ml-2">{opt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Course & Date */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Date & course</h2>
                <p className="text-sm text-gray-500 mt-1">When and where is the tournament?</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Event Date *</label>
                <input type="date" name="eventDate" value={formData.eventDate} onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm" required />
              </div>
              {!useCustomCourse ? (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">Golf Course *</label>
                    <select name="courseId" value={formData.courseId} onChange={handleChange}
                      className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm">
                      <option value="">-- Select a course --</option>
                      {courses.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.city}, {c.state})</option>
                      ))}
                    </select>
                  </div>
                  {formData.courseId && (() => {
                    const tees = courses.find((c) => c.id === formData.courseId)?.tees;
                    if (!tees || tees.length === 0) return null;
                    return (
                      <div>
                        <label className="block text-sm font-semibold text-gray-900 mb-1.5">Tees for this tournament</label>
                        <p className="text-xs text-gray-500 mb-2">Pick which tees the field plays from — leave none selected to decide later.</p>
                        <div className="flex flex-wrap gap-2">
                          {tees.map((tee) => {
                            const active = formData.selectedTees.includes(tee);
                            return (
                              <button key={tee} type="button"
                                onClick={() => setFormData((prev) => ({
                                  ...prev,
                                  selectedTees: active ? prev.selectedTees.filter((t) => t !== tee) : [...prev.selectedTees, tee],
                                }))}
                                className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-colors ${
                                  active ? 'border-green-800 bg-green-800 text-white' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                                }`}>
                                {TEE_LABELS[tee] ?? tee}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <button type="button" onClick={() => setUseCustomCourse(true)}
                      className="text-sm text-green-800 font-medium hover:underline">+ Enter a course manually</button>
                    <Link href="/course/new"
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-800 border border-green-800 rounded-lg px-3 py-1.5 hover:bg-green-50 transition-colors">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                      </svg>
                      Course profile
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">Course Name *</label>
                    <input type="text" name="customCourseName" value={formData.customCourseName} onChange={handleChange} placeholder="e.g., Magnolia Club"
                      className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-gray-900 mb-1.5">City</label>
                      <input type="text" name="customCourseCity" value={formData.customCourseCity} onChange={handleChange} placeholder="Sanford"
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-900 mb-1.5">State</label>
                      <input type="text" name="customCourseState" value={formData.customCourseState} onChange={handleChange} placeholder="FL" maxLength={2}
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm" />
                    </div>
                  </div>
                  <button type="button" onClick={() => setUseCustomCourse(false)}
                    className="text-sm text-green-800 font-medium hover:underline">← Pick from existing courses</button>
                </>
              )}
            </div>
          )}

          {/* STEP 4: Pricing */}
          {step === 4 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Pricing</h2>
                <p className="text-sm text-gray-500 mt-1">Name your tournament and set the entry fee.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Tournament Name *</label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} placeholder="e.g., Springfield Charity Classic"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm" required />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Entry Fee per Player *</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input type="number" name="entryFee" value={formData.entryFee} onChange={handleChange}
                    className="w-full pl-8 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none text-sm" />
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-gray-500">Per foursome</span><span className="font-semibold text-gray-900">${(parseInt(formData.entryFee || '0') * parseInt(formData.teamSize || '4')).toLocaleString()}</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">Projected entry revenue</span><span className="font-bold text-green-800">${(parseInt(formData.maxPlayers || '0') * parseInt(formData.entryFee || '0')).toLocaleString()}</span></div>
                <p className="text-xs text-gray-400 pt-1">Based on {formData.maxPlayers} players at ${formData.entryFee}/player</p>
              </div>
            </div>
          )}

          {/* STEP 5: Sponsors */}
          {step === 5 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Sponsorship plan</h2>
                <p className="text-sm text-gray-500 mt-1">Optional for now — you can add sponsors later from your dashboard.</p>
              </div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-2">
                <p className="text-sm font-semibold text-green-900">Typical sponsorship tiers</p>
                <div className="text-xs text-green-800 space-y-1.5">
                  <div className="flex justify-between"><span>Presenting Sponsor</span><span className="font-semibold">$3,000 – $5,000</span></div>
                  <div className="flex justify-between"><span>Gold Sponsor</span><span className="font-semibold">$1,500 – $2,500</span></div>
                  <div className="flex justify-between"><span>Silver Sponsor</span><span className="font-semibold">$750 – $1,000</span></div>
                  <div className="flex justify-between"><span>Hole Sponsor (×18)</span><span className="font-semibold">$250 – $500 each</span></div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-1.5">Sponsorship notes</label>
                <textarea name="sponsorNotes" value={formData.sponsorNotes} onChange={handleChange} rows={3}
                  placeholder="Any sponsors you already have lined up, or notes for later..."
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-700 focus:border-transparent outline-none resize-none text-sm" />
              </div>
              <div className="bg-[#1a3a2a] rounded-lg p-4">
                <p className="text-sm text-green-100 leading-relaxed">
                  <strong className="text-white">Coach's note</strong> — entry fees cover your costs, sponsors fund your cause. A solid sponsorship menu adds $10,000–$15,000 to your gross. Best first targets: medical practices, law firms, financial advisors, local restaurants.
                </p>
              </div>
            </div>
          )}

          {/* STEP 6: Review */}
          {step === 6 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Review & publish</h2>
                <p className="text-sm text-gray-500 mt-1">Everything looks good? You can always edit later from your dashboard.</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-5 space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Tournament</span><span className="font-semibold text-gray-900">{formData.name || '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Organization</span><span className="font-semibold text-gray-900">{formData.causeName || '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Date</span><span className="font-semibold text-gray-900">{formData.eventDate || '—'}</span></div>
                <hr className="border-gray-200" />
                <div className="flex justify-between"><span className="text-gray-500">Course</span><span className="font-semibold text-gray-900">{useCustomCourse ? formData.customCourseName : (courses.find(c => c.id === formData.courseId)?.name || '—')}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Format</span><span className="font-semibold text-gray-900">{FORMAT_OPTIONS.find(o => o.value === formData.format)?.label || formData.format}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Team size</span><span className="font-semibold text-gray-900">{formData.teamSize} players</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Max score</span><span className="font-semibold text-gray-900">{MAX_SCORE_OPTIONS.find(o => o.value === formData.maxScoreRule)?.label}</span></div>
                <hr className="border-gray-200" />
                <div className="flex justify-between"><span className="text-gray-500">Start method</span><span className="font-semibold text-gray-900">{SHOTGUN_OPTIONS.find(o => o.value === formData.shotgunType)?.label}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Field size</span><span className="font-semibold text-gray-900">{formData.maxPlayers} players</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Entry fee</span><span className="font-semibold text-gray-900">${formData.entryFee}/player</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Projected revenue</span><span className="font-bold text-green-800">${(parseInt(formData.maxPlayers || '0') * parseInt(formData.entryFee || '0')).toLocaleString()}</span></div>
              </div>
              {formData.causeHook && (
                <div className="bg-green-50 rounded-lg p-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Donor headline</p>
                  <p className="text-sm font-semibold text-green-800">{formData.causeHook}</p>
                </div>
              )}
            </div>
          )}

          {error && <div className="mt-5 p-3 bg-red-50 border border-red-200 rounded-lg"><p className="text-sm text-red-700">{error}</p></div>}
          {success && <div className="mt-5 p-3 bg-green-50 border border-green-200 rounded-lg"><p className="text-sm text-green-700">{success}</p></div>}

          {/* Navigation */}
          <div className="mt-8 flex justify-between">
            {step > 1 ? (
              <button type="button" onClick={() => { setStep(step - 1); setError(null); }} disabled={loading}
                className="px-5 py-2.5 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
                {prevLabel}
              </button>
            ) : <div />}
            {step < TOTAL_STEPS ? (
              <button type="button" onClick={() => { if (canAdvance()) setStep(step + 1); else setError('Please fill in the required fields.'); }}
                className="px-5 py-2.5 text-sm font-medium text-white bg-green-800 rounded-lg hover:bg-green-900 transition-colors">
                {nextLabel}
              </button>
            ) : (
              <button type="button" onClick={handleSubmit} disabled={loading}
                className="px-5 py-2.5 text-sm font-medium text-white bg-green-800 rounded-lg hover:bg-green-900 disabled:opacity-50 transition-colors">
                {loading ? 'Creating...' : 'Publish Tournament'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
