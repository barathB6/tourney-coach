'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';
import { SCRIPTS, FAQ_CHIPS, lookupScript, daysOut, computeNudges } from '@/lib/coach/scripts';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Tournament {
  id: string;
  name: string;
  event_date: string;
  format: string;
  max_players: number;
  team_size: number;
  entry_fee: number;
  status: string;
  cause_story_full: string | null;
  cause_story: string | null;
  organization: string | null;
}

// ── Leaderboard demo data ────────────────────────────────────────────────
interface LbTeam { name: string; pace: 'good' | 'warn' | 'late'; scores: number[]; thru: number; }

const INITIAL_TEAMS: LbTeam[] = [
  { name: "Curry & Friends",    pace: "good", scores: [-1,-1,-1,-1, 0,-1,-2,-1,-1,-1,-1,-1,-1,-1], thru: 14 },
  { name: "Riverside Law",      pace: "good", scores: [-1,-1, 0,-1,-1,-1,-1,-1, 0,-1,-1,-1,-1, 0], thru: 14 },
  { name: "CFR Medical Group",  pace: "warn", scores: [-1, 0,-1,-1,-1, 0,-1,-1,-1,-1, 0,-1,-1,-1], thru: 14 },
  { name: "The Garcia Family",  pace: "good", scores: [-1,-1,-1, 0,-1,-1,-1,-1,-1, 0,-1,-1,-1,-1], thru: 14 },
  { name: "Magnolia Capital",   pace: "good", scores: [-1,-1, 0,-1, 0,-1,-1,-1,-1,-1,-1, 0,-1,-1], thru: 14 },
  { name: "DePaolo & Assoc.",   pace: "warn", scores: [ 0,-1,-1,-1, 0,-1,-1, 0,-1,-1,-1,-1, 0,-1], thru: 13 },
  { name: "Wilson Insurance",   pace: "good", scores: [-1,-1, 0,-1,-1,-1, 0, 0,-1,-1, 0,-1,-1, 0], thru: 14 },
  { name: "Sanford Fire Dept",  pace: "good", scores: [-1, 0,-1, 0,-1,-1,-1, 0,-1,-1,-1, 0,-1,-1], thru: 14 },
  { name: "Lake Mary Builders", pace: "late", scores: [ 0, 0,-1,-1, 0,-1,-1,-1, 0,-1,-1,-1, 0,-1], thru: 13 },
  { name: "First Baptist",      pace: "good", scores: [-1,-1,-1,-1,-1, 0, 0,-1, 0, 0,-1,-1,-1,-1], thru: 14 },
  { name: "Oviedo Dental",      pace: "warn", scores: [ 0,-1,-1, 0, 0,-1,-1,-1,-1,-1, 0,-1,-1, 0], thru: 13 },
  { name: "Seminole Title",     pace: "good", scores: [-1, 0,-1,-1, 0, 0,-1,-1, 0,-1,-1,-1, 0, 0], thru: 14 },
];

const COE_GROUPS = [
  { rank: 1, initials: 'MW', bg: '#f5e6b3', fg: '#7a5c00', rankColor: '#b8860b', name: 'Mike & Wilson Group',    loc: 'Orlando · 14 tournaments',     given: '$18,400', prize: true },
  { rank: 2, initials: 'RL', bg: '#e8e8e8', fg: '#555',    rankColor: '#b8860b', name: 'Riverside Law Group',    loc: 'Winter Park · 11 tournaments', given: '$14,200', prize: true },
  { rank: 3, initials: 'SH', bg: '#f5dece', fg: '#7a3a10', rankColor: '#888',    name: 'Sarah & The Hendersons', loc: 'Sanford · 9 tournaments',      given: '$11,650', prize: true },
  { rank: 4, initials: 'CF', bg: '#dceeff', fg: '#1a5fa8', rankColor: '#888',    name: 'CFR Medical Partners',   loc: 'Lake Mary · 8 tournaments',    given: '$9,800',  prize: true },
  { rank: 5, initials: 'TG', bg: '#e8f5e9', fg: '#2e7d32', rankColor: '#a0522d', name: 'The Garcia Family',      loc: 'Deltona · 7 tournaments',      given: '$8,250',  prize: true },
  { rank: 6, initials: 'DP', bg: '#f5f5f3', fg: '#6b6b67', rankColor: '#9b9b96', name: 'DePaolo & Associates',   loc: 'Oviedo · 6 tournaments',       given: '$6,900',  prize: false },
];

const RADIUS_OPTIONS = [
  { label: '15 miles — 184 players', count: 184 },
  { label: '25 miles — 347 players', count: 347 },
  { label: '35 miles — 521 players', count: 521 },
  { label: '50 miles — 789 players', count: 789 },
];

function totalScore(t: LbTeam) { return t.scores.slice(0, t.thru).reduce((a, b) => a + b, 0); }
function scoreLabel(n: number) {
  if (n < 0) return { txt: String(n), color: '#16a34a' };
  if (n > 0) return { txt: '+' + n, color: '#c0392b' };
  return { txt: 'E', color: '#6b6b67' };
}

// ── Main component ─────────────────────────────────────────────────────────
export default function CoachPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ id: string; name: string; initials: string } | null>(null);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [allTournaments, setAllTournaments] = useState<Tournament[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [followups, setFollowups] = useState<string[]>([]);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [speakEnabled, setSpeakEnabled] = useState(true);
  const [listening, setListening] = useState(false);
  const [statusText, setStatusText] = useState('Tap the mic or type your question');
  const [switchOpen, setSwitchOpen] = useState(false);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [regCount, setRegCount] = useState(0);
  const [sponsorSold, setSponsorSold] = useState(0);
  const [sponsorTotal, setSponsorTotal] = useState(0);
  const [dismissedNudges, setDismissedNudges] = useState<Set<string>>(new Set());
  const [screen, setScreen] = useState<'coach' | 'circle' | 'board'>('coach');
  // TourneyCircle state
  const [tcTab, setTcTab] = useState<'organizer' | 'excellence'>('organizer');
  const [radiusIdx, setRadiusIdx] = useState(1);
  const [showPerf, setShowPerf] = useState(false);
  const [convFillW, setConvFillW] = useState(0);
  const [coePeriod, setCoePeriod] = useState('2026 Season');
  // Leaderboard state
  const [teams, setTeams] = useState<LbTeam[]>(INITIAL_TEAMS);
  const [kitchenShown, setKitchenShown] = useState(false);
  const [kitchenSecs, setKitchenSecs] = useState(2700);
  const [updatedTeam, setUpdatedTeam] = useState<string | null>(null);
  const lbStartedRef = useRef(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  const scrollToBottom = useCallback(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // ── TTS ─────────────────────────────────────────────────────────────────
  function speak(text: string) {
    if (!speakEnabled || typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const clean = text.replace(/\n\n/g, '. ').replace(/\n/g, ' ').replace(/\$(\d)/g, '$1 dollars ').replace(/ {2,}/g, ' ').trim();
    const utt = new SpeechSynthesisUtterance(clean);
    const voices = window.speechSynthesis.getVoices();
    const priority = ['Microsoft Ryan Online (Natural) - English (United Kingdom)', 'Microsoft Guy Online (Natural) - English (United States)', 'Google UK English Male', 'Daniel', 'Alex', 'Google US English'];
    for (const name of priority) {
      const v = voices.find(v => v.name === name);
      if (v) { utt.voice = v; break; }
    }
    if (!utt.voice) {
      const fallback = voices.find(v => v.lang === 'en-GB') || voices.find(v => v.lang.startsWith('en')) || voices[0];
      if (fallback) utt.voice = fallback;
    }
    utt.rate = 1.15;
    utt.onstart = () => setStatusText('Coach is speaking...');
    utt.onend = () => setStatusText('Tap the mic or type your question');
    utt.onerror = () => setStatusText('Tap the mic or type your question');
    window.speechSynthesis.speak(utt);
  }

  function stopSpeaking() {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    setStatusText('Tap the mic or type your question');
  }

  // ── Mic ─────────────────────────────────────────────────────────────────
  function toggleMic() {
    if (typeof window === 'undefined') return;
    const SR = (window as unknown as Record<string, unknown>).SpeechRecognition || (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    if (!SR) { setStatusText('Voice needs Chrome'); return; }
    if (listening && recognitionRef.current) { recognitionRef.current.stop(); return; }
    stopSpeaking();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recog = new (SR as any)();
    recognitionRef.current = recog;
    recog.continuous = false;
    recog.interimResults = true;
    recog.lang = 'en-US';
    recog.onstart = () => { setListening(true); setStatusText('Listening...'); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recog.onresult = (e: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transcript = Array.from(e.results).map((r: any) => r[0].transcript).join('');
      setInput(transcript);
    };
    recog.onend = () => {
      setListening(false);
      setStatusText('Tap the mic or type your question');
      const val = inputRef.current?.value?.trim();
      if (val) sendMessage(val);
    };
    recog.onerror = () => { setListening(false); setStatusText('Could not hear you — try again'); };
    recog.start();
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      const u = session?.user;
      if (!u) { router.replace('/sign-in'); return; }

      const fullName = u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Organizer';
      const initials = fullName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase();
      setUser({ id: u.id, name: fullName.split(' ')[0], initials });

      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${u.id}`); } catch { /* */ }

      const { data: allT, error: tErr } = await supabase.from('tournaments').select('*').eq('organizer_id', u.id).order('created_at', { ascending: false });
      if (tErr) console.error('[Coach] tournaments query failed:', tErr.message);
      const all: Tournament[] = allT ?? [];
      setAllTournaments(all);

      const picked = all.find(t => t.id === selectedId) ?? all[0] ?? null;
      if (picked) {
        setTournament(picked);
        const { count } = await supabase.from('registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', picked.id).in('payment_status', ['pending', 'paid']);
        setRegCount(count ?? 0);

        // Sponsorship progress feeds the proactive coaching triggers below.
        const { data: tiers } = await supabase.from('sponsorship_tiers').select('quantity').eq('tournament_id', picked.id);
        const { data: soldRows } = await supabase.from('sponsors').select('status').eq('tournament_id', picked.id);
        if (tiers) setSponsorTotal(tiers.reduce((sum, t) => sum + (t.quantity ?? 0), 0));
        if (soldRows) setSponsorSold(soldRows.filter(s => ['paid', 'invoiced', 'verbal'].includes(s.status)).length);
      }

      setLoading(false);

      // Show welcome message
      const welcome = "Hey, welcome to TourneyCoach! I'm your AI coaching assistant. Whether this is your first tournament or your tenth, I'm here to help every step of the way. What's on your mind?";
      setMessages([{ role: 'assistant', content: welcome }]);
      setTimeout(() => {
        if (typeof window !== 'undefined' && window.speechSynthesis) speak(welcome);
      }, 400);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.getVoices();
    // Stop speaking when leaving the page
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, []);

  // ── Leaderboard simulation ───────────────────────────────────────────────
  useEffect(() => {
    if (screen !== 'board' || lbStartedRef.current) return;
    lbStartedRef.current = true;
    const kitchenDelay = setTimeout(() => setKitchenShown(true), 1800);
    const sim = setInterval(() => {
      setTeams(prev => {
        const copy = prev.map(t => ({ ...t, scores: [...t.scores] }));
        const idx = Math.floor(Math.random() * copy.length);
        const t = copy[idx];
        if (t.thru < 18) {
          t.scores.push(Math.random() < 0.55 ? -1 : Math.random() < 0.3 ? 0 : 1);
          t.thru++;
          setUpdatedTeam(t.name);
          setTimeout(() => setUpdatedTeam(null), 800);
        }
        return copy;
      });
    }, 3500);
    return () => { clearTimeout(kitchenDelay); clearInterval(sim); };
  }, [screen]);

  // Kitchen countdown
  useEffect(() => {
    if (!kitchenShown) return;
    const timer = setInterval(() => setKitchenSecs(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [kitchenShown]);

  // ── Auth token helper ────────────────────────────────────────────────────
  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }

  async function switchTournament(t: Tournament) {
    setTournament(t);
    setSwitchOpen(false);
    if (user) {
      try { localStorage.setItem(`tourney_selected_tournament_${user.id}`, t.id); } catch { /* */ }
    }
    const { count } = await supabase.from('registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', t.id).in('payment_status', ['pending', 'paid']);
    setRegCount(count ?? 0);
  }

  // ── Send message ─────────────────────────────────────────────────────────
  async function sendMessage(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || streaming) return;
    setInput('');
    stopSpeaking();

    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setStreaming(true);
    setFollowups([]);
    setStatusText('Coach is thinking...');

    const script = lookupScript(msg);

    // Demo mode or no script: use scripted responses
    if (mode === 'demo' || script) {
      await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
      if (script) {
        setMessages(prev => [...prev, { role: 'assistant', content: script.answer }]);
        setFollowups(script.followups);
        speak(script.spoken || script.answer);
      } else {
        const fb = "Good question! Tap any suggested question below for a full coached answer, or switch to Live AI mode in the header to ask me anything.";
        setMessages(prev => [...prev, { role: 'assistant', content: fb }]);
        setFollowups(FAQ_CHIPS);
        speak(fb);
      }
      setStreaming(false);
      setStatusText('Tap the mic or type your question');
      return;
    }

    // Live AI mode — try API
    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      const token = await getToken();
      const res = await fetch('/api/coach/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: msg, conversationId: activeConvId || undefined, tournamentId: tournament?.id }),
      });

      if (res.status === 503) {
        setMode('demo');
        setMessages(prev => prev.slice(0, -1));
        const fb = "Live AI is not configured yet — I've switched to Demo Mode. Tap any suggested question for a full answer!";
        setMessages(prev => [...prev, { role: 'assistant', content: fb }]);
        setFollowups(FAQ_CHIPS);
        speak(fb);
        setStreaming(false);
        setStatusText('Tap the mic or type your question');
        return;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to connect' }));
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: `Sorry, something went wrong: ${err.error}` };
          return copy;
        });
        setStreaming(false);
        setStatusText('Tap the mic or type your question');
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'delta') {
              setMessages(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, content: last.content + data.text };
                return copy;
              });
              if (!activeConvId && data.conversationId) setActiveConvId(data.conversationId);
            }
          } catch { /* skip */ }
        }
      }

      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.content) speak(last.content);
        return prev;
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: 'Connection lost. Please try again.' };
          return copy;
        });
      }
    }

    setStreaming(false);
    setStatusText('Tap the mic or type your question');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  if (loading) {
    return <div style={{ minHeight: '100vh', background: '#f5f5f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#1a1a18', fontSize: 14, fontFamily: "-apple-system, 'Helvetica Neue', sans-serif" }}>Loading...</p>
    </div>;
  }

  const days = tournament?.event_date ? daysOut(tournament.event_date) : null;
  const chipsToShow = followups.length > 0 ? followups : FAQ_CHIPS;

  // Proactive nudges: only while the conversation is fresh (just the welcome),
  // and only those the organizer hasn't dismissed this session.
  const activeNudges = (tournament && messages.length <= 1)
    ? computeNudges({
        daysOut: days,
        regCount,
        maxPlayers: tournament.max_players ?? 0,
        sponsorSold,
        sponsorTotal,
        causeStoryDone: !!(tournament.cause_story_full || tournament.cause_story),
      }).filter(n => !dismissedNudges.has(n.id))
    : [];

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f3', fontFamily: "-apple-system, 'Helvetica Neue', sans-serif" }}>
      <div style={{ width: '100%', maxWidth: 1400, height: '92vh', maxHeight: 920, display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 16, overflow: 'hidden', border: '0.5px solid rgba(0,0,0,0.09)', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>

        {/* ═══ HEADER ═══ */}
        <div style={{ padding: '13px 24px', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0, borderBottom: '0.5px solid rgba(0,0,0,0.09)' }}>
          <div style={{ width: 36, height: 36, background: '#1B6B3A', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div><h1 style={{ color: '#1a1a18', fontSize: 17, fontWeight: 700, fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: '-0.01em', margin: 0 }}>TourneyCoach</h1></div>
          <div style={{ width: 0.5, height: 26, background: 'rgba(0,0,0,0.16)', flexShrink: 0 }} />
          <div style={{ minWidth: 0, position: 'relative' }}>
            <button
              onClick={(e) => { e.stopPropagation(); setSwitchOpen(o => !o); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'inherit' }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a18', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tournament?.name || 'No Tournament'}</div>
                <div style={{ fontSize: 11.5, color: '#6b6b67', marginTop: 1 }}>
                  {tournament ? [
                    new Date(tournament.event_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    tournament.format ? tournament.format.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null,
                    tournament.max_players ? `${tournament.max_players} players` : null,
                    days !== null ? `${days} days out` : null,
                  ].filter(Boolean).join(' · ') : ''}
                </div>
              </div>
              {allTournaments.length > 1 && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: '#6b6b67', flexShrink: 0 }}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>

            {switchOpen && allTournaments.length > 0 && (
              <div style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', background: '#fff', border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 12, boxShadow: '0 4px 20px rgba(15,74,38,.12)', minWidth: 260, zIndex: 100, overflow: 'hidden' }}>
                <div style={{ padding: '8px 12px 6px', fontSize: 10.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#6b6b67' }}>
                  Switch event
                </div>
                {allTournaments.map(t => (
                  <button
                    key={t.id}
                    onClick={(e) => { e.stopPropagation(); switchTournament(t); }}
                    style={{
                      width: '100%', padding: '10px 14px', background: t.id === tournament?.id ? 'rgba(27,107,58,0.08)' : 'transparent',
                      border: 'none', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                      fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: t.id === tournament?.id ? '#1B6B3A' : 'rgba(0,0,0,0.16)', flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1a1a18' }}>{t.name}</div>
                      <div style={{ fontSize: 11.5, color: '#6b6b67', marginTop: 1 }}>
                        {new Date(t.event_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        {t.format ? ` · ${t.format.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}` : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#1B6B3A', background: 'rgba(27,107,58,0.1)', borderRadius: 20, padding: '5px 12px', whiteSpace: 'nowrap' }}>
              {regCount} registered
            </span>

            {/* Switch event */}
            <button onClick={(e) => { e.stopPropagation(); setSwitchOpen(o => !o); }} style={{ fontSize: 12.5, fontWeight: 600, color: '#1a1a18', background: '#fff', border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 8, padding: '6px 13px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              Switch event
            </button>

            {/* Demo / Live AI toggle */}
            <div style={{ display: 'flex', background: '#f5f5f3', borderRadius: 20, padding: 2, gap: 2 }}>
              <button onClick={() => setMode('demo')} style={{ padding: '4px 10px', borderRadius: 18, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: 'none', background: mode === 'demo' ? '#1B6B3A' : 'transparent', color: mode === 'demo' ? '#fff' : '#9b9b96', fontFamily: 'inherit', letterSpacing: '0.03em' }}>Demo</button>
              <button onClick={() => setMode('live')} style={{ padding: '4px 10px', borderRadius: 18, fontSize: 10, fontWeight: 600, cursor: 'pointer', border: 'none', background: mode === 'live' ? '#1B6B3A' : 'transparent', color: mode === 'live' ? '#fff' : '#9b9b96', fontFamily: 'inherit', letterSpacing: '0.03em' }}>Live AI</button>
            </div>

            {/* Speaker toggle */}
            <button onClick={() => { setSpeakEnabled(s => { if (s) stopSpeaking(); return !s; }); }} style={{ width: 30, height: 30, background: '#f5f5f3', border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: speakEnabled ? 1 : 0.5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1B6B3A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                {speakEnabled ? <><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></> : <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>}
              </svg>
            </button>
          </div>
        </div>

        {/* ═══ PROGRESS BAR ═══ */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 24px', borderBottom: '0.5px solid rgba(0,0,0,0.09)', flexShrink: 0 }}>
          <span style={{ fontSize: 12.5, color: '#6b6b67', fontWeight: 500, whiteSpace: 'nowrap' }}>Setup progress</span>
          <div style={{ flex: 1, height: 6, background: '#f5f5f3', borderRadius: 4, overflow: 'hidden', maxWidth: 420 }}>
            <div style={{ height: '100%', background: '#1B6B3A', borderRadius: 4, width: '38%' }} />
          </div>
          <span style={{ fontSize: 12.5, color: '#1B6B3A', fontWeight: 600, whiteSpace: 'nowrap' }}>8 / 21 steps</span>
        </div>

        {/* ═══ TOP TABS ═══ */}
        <nav style={{ display: 'flex', gap: 0, padding: '0 24px', borderBottom: '0.5px solid rgba(0,0,0,0.09)', flexShrink: 0 }}>
          {([['coach', 'AI Coach'], ['circle', 'TourneyCircle'], ['board', 'Leaderboard']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setScreen(id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', background: 'transparent', fontFamily: 'inherit', padding: '11px 4px', marginRight: 26, borderBottom: screen === id ? '2px solid #1B6B3A' : '2px solid transparent' }}>
              <span style={{ fontSize: 13, color: screen === id ? '#1B6B3A' : '#9b9b96', fontWeight: 600, letterSpacing: '0.01em' }}>{label}</span>
            </button>
          ))}
        </nav>

        {/* ═══ MAIN ROW ═══ */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── Chat area ── */}
          {screen === 'coach' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            {/* Messages */}
            <div ref={msgsRef} style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 6px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 800, margin: '0 auto', width: '100%' }}>
              {messages.map((msg, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row', animation: 'pop .2s ease' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, marginTop: 2, background: msg.role === 'user' ? '#f5f5f3' : '#1B6B3A', color: msg.role === 'user' ? '#6b6b67' : '#fff' }}>
                    {msg.role === 'user' ? (user?.initials || 'You') : 'TC'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '80%', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{ padding: '11px 14px', fontSize: 14, lineHeight: 1.7, color: msg.role === 'user' ? '#fff' : '#1a1a18', background: msg.role === 'user' ? '#1B6B3A' : '#f5f5f3', borderRadius: msg.role === 'user' ? '15px 4px 15px 15px' : '4px 15px 15px 15px', whiteSpace: 'pre-wrap' }}>
                      {msg.content || (streaming && i === messages.length - 1 ? (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '4px 0' }}>
                          <span style={{ width: 5, height: 5, background: '#9b9b96', borderRadius: '50%', animation: 'bop 1.1s infinite' }} />
                          <span style={{ width: 5, height: 5, background: '#9b9b96', borderRadius: '50%', animation: 'bop 1.1s infinite .2s' }} />
                          <span style={{ width: 5, height: 5, background: '#9b9b96', borderRadius: '50%', animation: 'bop 1.1s infinite .4s' }} />
                        </span>
                      ) : '')}
                    </div>
                    <div style={{ fontSize: 10.5, color: '#9b9b96', padding: '0 3px' }}>
                      {new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* ── Bottom controls ── */}
            <div style={{ flexShrink: 0, maxWidth: 800, margin: '0 auto', width: '100%' }}>
              {/* Status bar */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 24px 0', minHeight: 26 }}>
                <span style={{ fontSize: 11, color: statusText.includes('speaking') ? '#6a5acd' : statusText.includes('Listening') ? '#1B6B3A' : '#9b9b96', fontWeight: statusText.includes('speaking') || statusText.includes('Listening') ? 600 : 400 }}>
                  {statusText}
                </span>
                {statusText.includes('speaking') && (
                  <button onClick={stopSpeaking} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(106,90,205,0.1)', border: '0.5px solid rgba(106,90,205,0.25)', borderRadius: 20, padding: '3px 9px', cursor: 'pointer', fontSize: 11, color: '#6a5acd', fontWeight: 500, fontFamily: 'inherit' }}>
                    Stop
                  </button>
                )}
              </div>

              {/* Proactive coaching nudges */}
              {activeNudges.length > 0 && (
                <div style={{ padding: '4px 24px 2px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {activeNudges.map(n => (
                    <div key={n.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'rgba(184,134,11,0.08)', border: '0.5px solid rgba(184,134,11,0.25)', borderRadius: 10, padding: '10px 12px' }}>
                      <span style={{ fontSize: 15, lineHeight: 1.2, marginTop: 1 }}>💡</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: '#6b5a2b', lineHeight: 1.5 }}>{n.text}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button onClick={() => { setDismissedNudges(prev => new Set(prev).add(n.id)); sendMessage(n.question); }} style={{ fontSize: 11.5, fontWeight: 600, color: '#fff', background: '#1B6B3A', border: 'none', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
                            Yes, let&rsquo;s talk
                          </button>
                          <button onClick={() => setDismissedNudges(prev => new Set(prev).add(n.id))} style={{ fontSize: 11.5, color: '#9b9b96', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                            Not now
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Chips */}
              <div style={{ padding: '6px 24px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 10, color: '#9b9b96', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {followups.length > 0 ? 'Follow-up questions' : 'Suggested questions'}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => sendMessage('I need to talk to a human')} title="Get help from a person" style={{ fontSize: 10, color: '#6b6b67', background: 'none', border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 8, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>Talk to a human</button>
                    <button onClick={() => setFollowups([])} style={{ fontSize: 10, color: '#1B6B3A', background: 'rgba(27,107,58,0.1)', border: 'none', borderRadius: 8, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>FAQ</button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {chipsToShow.map(q => (
                    <button key={q} onClick={() => sendMessage(q)} style={{ background: followups.length > 0 ? 'rgba(27,107,58,0.1)' : '#f5f5f3', border: followups.length > 0 ? '0.5px solid rgba(27,107,58,0.2)' : '0.5px solid rgba(0,0,0,0.09)', borderRadius: 20, padding: '5px 11px', fontSize: 11.5, color: followups.length > 0 ? '#1B6B3A' : '#6b6b67', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>

              {/* Input */}
              <div style={{ borderTop: '0.5px solid rgba(0,0,0,0.09)', padding: '7px 24px 10px' }}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'flex-end' }}>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 88) + 'px'; }}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask your coach anything..."
                    rows={1}
                    disabled={streaming}
                    style={{ flex: 1, border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 18, padding: '8px 13px', fontSize: 13.5, fontFamily: 'inherit', resize: 'none', minHeight: 38, maxHeight: 88, background: '#f5f5f3', color: '#1a1a18', outline: 'none', lineHeight: 1.45 }}
                  />
                  <button onClick={toggleMic} style={{ width: 40, height: 40, borderRadius: '50%', border: 'none', background: listening ? '#c0392b' : '#1B6B3A', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background .18s' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                  </button>
                  <button onClick={() => sendMessage()} disabled={!input.trim() || streaming} style={{ width: 40, height: 40, borderRadius: '50%', border: '0.5px solid rgba(0,0,0,0.16)', background: '#f5f5f3', color: '#6b6b67', cursor: input.trim() && !streaming ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
                <div style={{ textAlign: 'center', fontSize: 10, color: '#9b9b96', marginTop: 5 }}>TourneyCoach.com &nbsp;&middot;&nbsp; Patent Pending</div>
              </div>
            </div>
          </div>
          )}

          {/* ── TourneyCircle screen ── */}
          {screen === 'circle' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, maxWidth: 640, margin: '0 auto', width: '100%' }}>
            {/* TC tabs */}
            <div style={{ display: 'flex', borderBottom: '0.5px solid rgba(0,0,0,0.09)', flexShrink: 0 }}>
              <button onClick={() => setTcTab('organizer')} style={{ flex: 1, padding: '10px 8px', fontSize: 12, fontWeight: 500, color: tcTab === 'organizer' ? '#1B6B3A' : '#9b9b96', cursor: 'pointer', textAlign: 'center', borderBottom: tcTab === 'organizer' ? '2px solid #1B6B3A' : '2px solid transparent', background: 'none', border: 'none', borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: tcTab === 'organizer' ? '#1B6B3A' : 'transparent', fontFamily: 'inherit' }}>Organizer View</button>
              <button onClick={() => setTcTab('excellence')} style={{ flex: 1, padding: '10px 8px', fontSize: 12, fontWeight: 500, color: tcTab === 'excellence' ? '#1B6B3A' : '#9b9b96', cursor: 'pointer', textAlign: 'center', background: 'none', border: 'none', borderBottomWidth: 2, borderBottomStyle: 'solid', borderBottomColor: tcTab === 'excellence' ? '#1B6B3A' : 'transparent', fontFamily: 'inherit' }}>Circle of Excellence</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {tcTab === 'organizer' && (
              <div style={{ padding: '16px 14px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 14 }}>
                  <div style={{ background: '#f5f5f3', borderRadius: 8, padding: '9px 7px', textAlign: 'center' }}>
                    <div style={{ fontSize: 19, fontWeight: 600, color: '#1B6B3A' }}>347</div>
                    <div style={{ fontSize: 9.5, color: '#6b6b67', marginTop: 2, lineHeight: 1.3 }}>Players within 25 mi</div>
                  </div>
                  <div style={{ background: '#f5f5f3', borderRadius: 8, padding: '9px 7px', textAlign: 'center' }}>
                    <div style={{ fontSize: 19, fontWeight: 600, color: '#1B6B3A' }}>62</div>
                    <div style={{ fontSize: 9.5, color: '#6b6b67', marginTop: 2, lineHeight: 1.3 }}>Corporate accounts</div>
                  </div>
                  <div style={{ background: '#f5f5f3', borderRadius: 8, padding: '9px 7px', textAlign: 'center' }}>
                    <div style={{ fontSize: 19, fontWeight: 600, color: '#1B6B3A' }}>$29</div>
                    <div style={{ fontSize: 9.5, color: '#6b6b67', marginTop: 2, lineHeight: 1.3 }}>Per notification</div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: '#6b6b67' }}>Notification radius</label>
                  <select value={radiusIdx} onChange={e => { setRadiusIdx(Number(e.target.value)); setShowPerf(false); setConvFillW(0); }} style={{ fontSize: 12, border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 6, padding: '4px 8px', background: '#f5f5f3', color: '#1a1a18', fontFamily: 'inherit', outline: 'none' }}>
                    {RADIUS_OPTIONS.map((r, i) => <option key={i} value={i}>{r.label}</option>)}
                  </select>
                </div>

                <div style={{ background: 'rgba(27,107,58,0.1)', border: '0.5px solid rgba(27,107,58,0.2)', borderRadius: 10, padding: 13, marginBottom: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 26, fontWeight: 700, color: '#1B6B3A' }}>{RADIUS_OPTIONS[radiusIdx].count}</div>
                  <div style={{ fontSize: 11.5, color: '#6b6b67', marginTop: 3 }}>registered TourneyCircle players want to hear about tournaments near you</div>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 8 }}>
                    <div style={{ fontSize: 10.5, color: '#6b6b67', textAlign: 'center' }}><span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#1a1a18' }}>285</span>Individual</div>
                    <div style={{ fontSize: 10.5, color: '#6b6b67', textAlign: 'center' }}><span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#1a1a18' }}>62</span>Corporate</div>
                    <div style={{ fontSize: 10.5, color: '#6b6b67', textAlign: 'center' }}><span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#1a1a18' }}>41</span>CoE members</div>
                  </div>
                </div>

                <button onClick={() => { setShowPerf(true); setTimeout(() => setConvFillW(22), 100); }} style={{ width: '100%', background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 10, padding: 12, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0"/></svg>
                  Notify {RADIUS_OPTIONS[radiusIdx].count} Players — $29
                </button>
                <div style={{ textAlign: 'center', fontSize: 10.5, color: '#9b9b96', marginTop: 5 }}>TourneyCoach sends on your behalf. You never see names or emails.</div>

                {showPerf && (
                <div style={{ background: '#f5f5f3', borderRadius: 10, padding: 12, marginTop: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#6b6b67', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Notification performance</div>
                  {[['Players notified', '347'], ['Clicked your link', '73 (21%)'], ['Registered', '16 players — 4 foursomes']].map(([l, v], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '0.5px solid rgba(0,0,0,0.09)' }}>
                      <span style={{ fontSize: 11.5, color: '#6b6b67' }}>{l}</span><strong style={{ fontSize: 12, color: '#1a1a18' }}>{v}</strong>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ fontSize: 11.5, color: '#6b6b67' }}>Revenue to your cause</span><strong style={{ fontSize: 12, color: '#1B6B3A' }}>$2,400</strong>
                  </div>
                  <div style={{ height: 3, background: 'rgba(0,0,0,0.09)', borderRadius: 2, marginTop: 7, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#1B6B3A', borderRadius: 2, width: `${convFillW}%`, transition: 'width 1.2s ease' }} />
                  </div>
                  <div style={{ fontSize: 10, color: '#9b9b96', marginTop: 4 }}>4.6% conversion · industry avg 3.1%</div>
                </div>
                )}

                <div style={{ display: 'flex', gap: 7, background: '#f5f5f3', borderRadius: 9, padding: '9px 11px', marginTop: 10, alignItems: 'flex-start' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9b9b96" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <p style={{ fontSize: 11, color: '#6b6b67', lineHeight: 1.5, margin: 0 }}>Player data never leaves TourneyCoach. You see counts and performance only — never names, emails, or contact details.</p>
                </div>
              </div>
              )}

              {tcTab === 'excellence' && (
              <div style={{ padding: '16px 14px' }}>
                <div style={{ background: 'linear-gradient(135deg,#163322 0%,#1B6B3A 100%)', borderRadius: 10, padding: 14, marginBottom: 14 }}>
                  <h3 style={{ color: '#fff', fontSize: 13.5, fontWeight: 600, margin: 0 }}>TourneyCircle of Excellence</h3>
                  <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, marginTop: 3, lineHeight: 1.5, marginBottom: 0 }}>Recognizing golfers who show up, give back, and make a difference year after year.</p>
                  <div style={{ background: 'rgba(255,255,255,0.1)', borderRadius: 6, padding: '7px 9px', marginTop: 9, display: 'flex', alignItems: 'center', gap: 7 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ffd700" strokeWidth="2"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>
                    <span style={{ color: '#ffd700', fontSize: 10.5, fontWeight: 600 }}>Top 5 groups earn a complimentary foursome — any TourneyCoach event</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
                  {['2026 Season', 'All-Time', 'Central FL'].map(p => (
                    <button key={p} onClick={() => setCoePeriod(p)} style={{ fontSize: 11, padding: '4px 11px', borderRadius: 20, border: coePeriod === p ? '0.5px solid #1B6B3A' : '0.5px solid rgba(0,0,0,0.16)', background: coePeriod === p ? '#1B6B3A' : '#f5f5f3', color: coePeriod === p ? '#fff' : '#6b6b67', cursor: 'pointer', fontFamily: 'inherit' }}>{p}</button>
                  ))}
                </div>
                {COE_GROUPS.map(g => (
                  <div key={g.rank} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', borderBottom: g.rank < 6 ? '0.5px solid rgba(0,0,0,0.09)' : 'none' }}>
                    <div style={{ width: 20, textAlign: 'center', fontSize: 12.5, fontWeight: 600, flexShrink: 0, color: g.rankColor }}>{g.rank}</div>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0, background: g.bg, color: g.fg }}>{g.initials}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1a1a18', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</div>
                      <div style={{ fontSize: 10.5, color: '#6b6b67', marginTop: 1 }}>{g.loc}</div>
                      {g.prize && <div style={{ fontSize: 9.5, background: 'rgba(184,134,11,0.1)', color: '#b8860b', borderRadius: 4, padding: '2px 5px', fontWeight: 600, marginTop: 2, display: 'inline-block' }}>Free foursome awarded</div>}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1B6B3A' }}>{g.given}</div>
                      <div style={{ fontSize: 10, color: '#9b9b96' }}>total given</div>
                    </div>
                  </div>
                ))}
                <button style={{ width: '100%', background: '#f5f5f3', border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 10, padding: 10, fontSize: 13, fontWeight: 600, color: '#1B6B3A', cursor: 'pointer', fontFamily: 'inherit', marginTop: 12 }}>Join TourneyCircle — Free for Players</button>
              </div>
              )}
            </div>
          </div>
          )}

          {/* ── Live Leaderboard screen ── */}
          {screen === 'board' && (() => {
            const sorted = [...teams].sort((a, b) => totalScore(a) - totalScore(b));
            const maxThru = Math.max(...teams.map(t => t.thru));
            return (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, maxWidth: 640, margin: '0 auto', width: '100%' }}>
            {/* Header */}
            <div style={{ background: '#fff', borderBottom: '0.5px solid rgba(0,0,0,0.09)', padding: '10px 14px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a18' }}>{tournament?.name || "St. Michael's Charity Classic"}</div>
                  <div style={{ fontSize: 11, color: '#6b6b67', marginTop: 1 }}>Magnolia Club, Sanford FL &nbsp;•&nbsp; Scramble &nbsp;•&nbsp; {maxThru} of 18 holes</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(27,107,58,0.1)', borderRadius: 20, padding: '4px 10px' }}>
                  <div style={{ width: 6, height: 6, background: '#1B6B3A', borderRadius: '50%', animation: 'pulse 1.5s infinite' }} />
                  <span style={{ fontSize: 11, color: '#1B6B3A', fontWeight: 600 }}>LIVE</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['72', 'Players'], ['18', 'Foursomes'], ['$18,400', 'Raised'], ['2:45', 'Est. finish']].map(([n, l], i) => (
                  <div key={i} style={{ flex: 1, background: '#f5f5f3', borderRadius: 7, padding: '7px 10px', textAlign: 'center' }}>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#1a1a18' }}>{n}</div>
                    <div style={{ fontSize: 10, color: '#6b6b67', marginTop: 1 }}>{l}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Kitchen alert */}
            {kitchenShown && (
            <div style={{ background: 'linear-gradient(135deg,#1B6B3A,#2d8a50)', borderRadius: 10, padding: '11px 13px', margin: '10px 14px 0', display: 'flex', alignItems: 'center', gap: 10, animation: 'slideIn .4s ease', flexShrink: 0 }}>
              <div style={{ width: 32, height: 32, background: 'rgba(255,255,255,0.15)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
              </div>
              <div>
                <h4 style={{ color: '#fff', fontSize: 12, fontWeight: 600, margin: 0 }}>Kitchen Notification Sent</h4>
                <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 10.5, marginTop: 1, marginBottom: 0 }}>Estimated finish in 45 minutes — auto-triggered by TourneyCoach</p>
              </div>
              <div style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.15)', borderRadius: 7, padding: '4px 8px', color: '#fff', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
                {Math.floor(kitchenSecs / 60)}:{String(kitchenSecs % 60).padStart(2, '0')}
              </div>
            </div>
            )}

            {/* Column headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 36px 36px 48px', gap: 4, padding: '7px 14px', background: '#f5f5f3', borderBottom: '0.5px solid rgba(0,0,0,0.09)', flexShrink: 0, marginTop: kitchenShown ? 10 : 0 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#9b9b96', textTransform: 'uppercase', letterSpacing: '0.05em' }}>#</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#9b9b96', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Team</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#9b9b96', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right' }}>Thru</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#9b9b96', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right' }}>Score</span>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#9b9b96', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right' }}>Total</span>
            </div>

            {/* Rows */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px' }}>
              {sorted.map((t, i) => {
                const tot = totalScore(t);
                const sl = scoreLabel(tot);
                const holeScore = t.scores[t.thru - 1] || 0;
                const hs = scoreLabel(holeScore);
                const paceTxt = t.pace === 'good' ? 'On pace' : t.pace === 'warn' ? 'Slightly behind' : 'Needs attention';
                const paceColor = t.pace === 'good' ? '#22c55e' : t.pace === 'warn' ? '#f59e0b' : '#ef4444';
                return (
                  <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 36px 36px 48px', gap: 4, alignItems: 'center', padding: '9px 0', borderBottom: i < sorted.length - 1 ? '0.5px solid rgba(0,0,0,0.09)' : 'none', background: updatedTeam === t.name ? 'rgba(27,107,58,0.06)' : 'transparent', transition: 'background .3s' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: i === 0 ? '#b8860b' : '#6b6b67' }}>{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1a1a18', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
                        <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: paceColor }} />
                        <span style={{ fontSize: 10, color: '#9b9b96' }}>{paceTxt}</span>
                      </div>
                    </div>
                    <span style={{ fontSize: 12, color: '#6b6b67', textAlign: 'right' }}>{t.thru}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', color: hs.color }}>{hs.txt}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', color: sl.color }}>{sl.txt}</span>
                  </div>
                );
              })}
            </div>

            {/* Pace legend */}
            <div style={{ display: 'flex', gap: 12, padding: '8px 14px', borderTop: '0.5px solid rgba(0,0,0,0.09)', flexShrink: 0 }}>
              {[['#22c55e', 'On pace'], ['#f59e0b', 'Slightly behind'], ['#ef4444', 'Needs attention']].map(([c, l], i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#9b9b96' }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />{l}
                </div>
              ))}
            </div>
          </div>
            );
          })()}

          {/* ═══ RIGHT SIDEBAR ═══ */}
          <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid rgba(0,0,0,0.09)', padding: 20, overflowY: 'auto', background: '#fff' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9b9b96', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Today&apos;s Path</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {[
                { label: 'Cause story locked', done: true },
                { label: 'Course confirmed', done: true },
                { label: 'Tournament format set', done: true },
                { label: 'Boost registration to 75', current: true },
                { label: 'Lock 4 hole sponsors' },
                { label: 'F&B headcount to course' },
                { label: 'Volunteer roles assigned' },
              ].map((item, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 0', borderBottom: i < 6 ? '0.5px solid rgba(0,0,0,0.09)' : 'none' }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, marginTop: 1,
                    background: item.done ? '#1B6B3A' : 'transparent',
                    border: item.done ? 'none' : item.current ? '2px solid #1B6B3A' : '2px solid rgba(0,0,0,0.16)',
                    color: item.done ? '#fff' : 'transparent',
                  }}>
                    {item.done ? '✓' : ''}
                  </div>
                  <span style={{
                    fontSize: 13, lineHeight: 1.4, paddingTop: 1,
                    color: item.done ? '#9b9b96' : item.current ? '#1a1a18' : '#6b6b67',
                    fontWeight: item.current ? 600 : 400,
                    textDecoration: item.done ? 'line-through' : 'none',
                  }}>
                    {item.label}
                  </span>
                </li>
              ))}
            </ul>

            {/* Pro Tip */}
            <div style={{ background: 'rgba(184,134,11,0.1)', border: '0.5px solid rgba(184,134,11,0.25)', borderRadius: 10, padding: 14, marginTop: 18 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#b8860b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Pro tip</div>
              <p style={{ fontSize: 12, color: '#6b6b67', lineHeight: 1.55, margin: 0 }}>A TourneyCircle notification 21 days out historically converts 4-6% of recipients. For 280 golfers that&apos;s typically 3-4 foursomes — well past the $29 break-even.</p>
            </div>

            {/* Back to Dashboard */}
            <button onClick={() => { stopSpeaking(); router.push('/dashboard'); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 18, padding: '10px 14px', background: '#fff', border: '0.5px solid rgba(0,0,0,0.16)', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: '#1B6B3A' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1B6B3A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              Back to Dashboard
            </button>
          </aside>
        </div>
      </div>

      {/* Close dropdown on outside click */}
      {switchOpen && <div onClick={() => setSwitchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />}

      <style>{`
        @keyframes pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bop { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .5; transform: scale(.85); } }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 760px) { aside { display: none !important; } }
        @media (max-width: 900px) { .app-shell { border-radius: 0 !important; height: 100vh !important; max-height: 100vh !important; } }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.16); border-radius: 3px; }
      `}</style>
    </div>
  );
}
