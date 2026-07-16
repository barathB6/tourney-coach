'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';
import { SCRIPTS, FAQ_CHIPS, lookupScript, daysOut, computeNudges } from '@/lib/coach/scripts';
import { toPlainText } from '@/lib/coach/format';

const TypingDots = () => (
  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '3px 0' }}>
    <span style={{ width: 5, height: 5, background: '#9b9b96', borderRadius: '50%', animation: 'tcbop 1.1s infinite' }} />
    <span style={{ width: 5, height: 5, background: '#9b9b96', borderRadius: '50%', animation: 'tcbop 1.1s infinite .2s' }} />
    <span style={{ width: 5, height: 5, background: '#9b9b96', borderRadius: '50%', animation: 'tcbop 1.1s infinite .4s' }} />
    <style>{'@keyframes tcbop{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-3px);opacity:1}}'}</style>
  </span>
);

interface Message { role: 'user' | 'assistant'; content: string; }
interface Tournament {
  id: string;
  name: string;
  event_date: string;
  max_players: number;
  cause_story_full: string | null;
  cause_story: string | null;
}

// Mounted once in the root layout so the coach is a persistent panel
// available from any organizer screen — not a page you have to navigate
// away to. Self-guards on auth (renders nothing until a session exists)
// and only shows on organizer-facing routes, never on public/player pages
// or the full /coach experience itself (avoids a duplicate panel there).
const ORGANIZER_PATH_PREFIXES = ['/dashboard', '/sponsors', '/setup', '/story', '/profile'];

const CoachIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M7 21V4.2c0-.4.3-.7.7-.6l9.7 2.3c.5.1.6.8.1 1l-5.6 2.7c-.3.1-.3.6 0 .7l3.2 1.6c.5.2.4.9-.1 1L7 16"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function CoachWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [open, setOpen] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [user, setUser] = useState<{ id: string; initials: string } | null>(null);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [regCount, setRegCount] = useState(0);
  const [sponsorSold, setSponsorSold] = useState(0);
  const [sponsorTotal, setSponsorTotal] = useState(0);
  const [dismissedNudges, setDismissedNudges] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [followups, setFollowups] = useState<string[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const msgsRef = useRef<HTMLDivElement>(null);

  // Lightweight auth check on every route — cheap (no tournament/stats
  // queries) so it doesn't slow down navigation between organizer screens.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setAuthed(!!session?.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setAuthed(!!session?.user));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const isOrganizerRoute = ORGANIZER_PATH_PREFIXES.some(p => pathname?.startsWith(p));
  const isFullCoachPage = pathname?.startsWith('/coach');

  // Fetch tournament + progress context only when the panel is actually
  // opened, so the widget adds zero extra queries to ordinary page loads.
  async function bootstrap() {
    if (bootstrapped) return;
    setBootstrapped(true);
    const { data: { session } } = await supabase.auth.getSession();
    const u = session?.user;
    if (!u) return;
    const fullName = u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Organizer';
    const initials = fullName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase();
    setUser({ id: u.id, initials });

    let selectedId: string | null = null;
    try { selectedId = localStorage.getItem(`tourney_selected_tournament_${u.id}`); } catch { /* */ }

    const fields = 'id, name, event_date, max_players, cause_story_full, cause_story';
    let picked: Tournament | null = null;
    if (selectedId) {
      const { data } = await supabase.from('tournaments').select(fields).eq('organizer_id', u.id).eq('id', selectedId).maybeSingle();
      picked = data;
    }
    if (!picked) {
      const { data } = await supabase.from('tournaments').select(fields).eq('organizer_id', u.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      picked = data;
    }
    if (picked) {
      setTournament(picked);
      const { count } = await supabase.from('registrations').select('id', { count: 'exact', head: true }).eq('tournament_id', picked.id).in('payment_status', ['pending', 'paid']);
      setRegCount(count ?? 0);
      const { data: tiers } = await supabase.from('sponsorship_tiers').select('quantity').eq('tournament_id', picked.id);
      const { data: soldRows } = await supabase.from('sponsors').select('status').eq('tournament_id', picked.id);
      if (tiers) setSponsorTotal(tiers.reduce((sum, t) => sum + (t.quantity ?? 0), 0));
      if (soldRows) setSponsorSold(soldRows.filter(s => ['paid', 'invoiced', 'verbal'].includes(s.status)).length);
    }

    // Resume the most recent conversation for this tournament instead of
    // always starting fresh — messages are already saved server-side, this
    // just makes the widget show them back on reopen.
    const resumed = picked ? await loadLatestConversation(picked.id) : null;
    if (resumed) {
      setActiveConvId(resumed.id);
      setMessages(resumed.messages);
    } else {
      setMessages([{ role: 'assistant', content: `Hey${fullName ? `, ${fullName.split(' ')[0]}` : ''}! What can I help with?` }]);
    }
  }

  async function loadLatestConversation(tournamentId: string): Promise<{ id: string; messages: Message[] } | null> {
    const { data: conv } = await supabase
      .from('coach_conversations')
      .select('id')
      .eq('tournament_id', tournamentId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!conv) return null;
    const { data: rows } = await supabase
      .from('coach_messages')
      .select('role, content')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true });
    if (!rows || rows.length === 0) return null;
    return { id: conv.id, messages: rows as Message[] };
  }

  function toggleOpen() {
    setOpen(o => {
      const next = !o;
      if (next) bootstrap();
      return next;
    });
  }

  async function sendMessage(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || streaming) return;
    setInput('');
    // Add the user turn AND an empty assistant bubble in the same tick — the
    // empty bubble renders the animated typing dots, so the coach visibly reacts
    // the instant you hit send, then fills in place once the reply is ready.
    setMessages(prev => [...prev, { role: 'user', content: msg }, { role: 'assistant', content: '' }]);
    setStreaming(true);
    setFollowups([]);

    const fillLast = (content: string) =>
      setMessages(prev => { const c = [...prev]; c[c.length - 1] = { role: 'assistant', content }; return c; });

    const script = lookupScript(msg);
    if (script) {
      await new Promise(r => setTimeout(r, 450 + Math.random() * 250));
      fillLast(script.answer);
      setFollowups(script.followups);
      setStreaming(false);
      return;
    }

    // Not in the scripted library — try live AI; falls back to a friendly
    // nudge toward the FAQ topics or the full coach page if it's not configured.
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/coach/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ message: msg, conversationId: activeConvId || undefined, tournamentId: tournament?.id }),
      });

      if (!res.ok) {
        const fb = "Good question! I don't have a scripted answer for that yet — tap a suggestion below, or open the full coach for live AI.";
        setMessages(prev => { const c = [...prev]; c[c.length - 1] = { role: 'assistant', content: fb }; return c; });
        setFollowups(FAQ_CHIPS);
        setStreaming(false);
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
                const c = [...prev];
                const last = c[c.length - 1];
                c[c.length - 1] = { ...last, content: last.content + data.text };
                return c;
              });
              if (!activeConvId && data.conversationId) setActiveConvId(data.conversationId);
            }
          } catch { /* skip */ }
        }
      }
    } catch {
      setMessages(prev => { const c = [...prev]; c[c.length - 1] = { role: 'assistant', content: 'Connection lost — please try again.' }; return c; });
    }
    setStreaming(false);
  }

  if (!authed || !isOrganizerRoute || isFullCoachPage) return null;

  const days = tournament?.event_date ? daysOut(tournament.event_date) : null;
  const activeNudges = (tournament && messages.length <= 1)
    ? computeNudges({
        daysOut: days, regCount, maxPlayers: tournament.max_players ?? 0,
        sponsorSold, sponsorTotal, causeStoryDone: !!(tournament.cause_story_full || tournament.cause_story),
      }).filter(n => !dismissedNudges.has(n.id))
    : [];
  const chipsToShow = followups.length > 0 ? followups : FAQ_CHIPS;

  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {open && (
        <div className="tc-coach-panel" style={{ position: 'absolute', bottom: 64, right: 0, width: 360, maxWidth: 'calc(100vw - 40px)', height: 520, maxHeight: 'calc(100vh - 110px)', background: '#fff', borderRadius: 16, boxShadow: '0 8px 40px rgba(0,0,0,0.22)', border: '1px solid var(--line, #E5E0D5)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line, #E5E0D5)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--primary, #1B6B3A)', display: 'grid', placeItems: 'center', color: '#fff', flexShrink: 0 }}><CoachIcon size={15} /></div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink, #1a1a18)' }}>AI Coach</div>
              <div style={{ fontSize: 11, color: '#6b6b67', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tournament ? tournament.name : 'Loading…'}</div>
            </div>
            <button onClick={() => router.push('/coach')} title="Open full coach" style={{ background: 'none', border: '1px solid var(--line, #E5E0D5)', borderRadius: 6, padding: '3px 7px', fontSize: 10.5, color: 'var(--primary, #1B6B3A)', cursor: 'pointer', fontFamily: 'inherit' }}>Expand</button>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9b9b96', fontSize: 16, padding: 2, lineHeight: 1 }}>✕</button>
          </div>

          {/* Messages */}
          <div ref={msgsRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 7, flexDirection: m.role === 'user' ? 'row-reverse' : 'row' }}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, marginTop: 2, background: m.role === 'user' ? '#f5f5f3' : 'var(--primary, #1B6B3A)', color: m.role === 'user' ? '#6b6b67' : '#fff' }}>
                  {m.role === 'user' ? (user?.initials || 'You') : 'TC'}
                </div>
                <div style={{ padding: '8px 11px', fontSize: 13, lineHeight: 1.55, borderRadius: m.role === 'user' ? '12px 3px 12px 12px' : '3px 12px 12px 12px', background: m.role === 'user' ? 'var(--primary, #1B6B3A)' : '#f5f5f3', color: m.role === 'user' ? '#fff' : '#1a1a18', maxWidth: '78%', whiteSpace: 'pre-wrap' }}>
                  {m.content
                    ? (m.role === 'assistant' ? toPlainText(m.content) : m.content)
                    : (i === messages.length - 1 ? <TypingDots /> : '')}
                </div>
              </div>
            ))}

            {activeNudges.map(n => (
              <div key={n.id} style={{ background: 'rgba(184,134,11,0.08)', border: '1px solid rgba(184,134,11,0.25)', borderRadius: 10, padding: '9px 10px' }}>
                <div style={{ fontSize: 11.5, color: '#6b5a2b', lineHeight: 1.45 }}>💡 {n.text}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                  <button onClick={() => { setDismissedNudges(prev => new Set(prev).add(n.id)); sendMessage(n.question); }} style={{ fontSize: 10.5, fontWeight: 600, color: '#fff', background: 'var(--primary, #1B6B3A)', border: 'none', borderRadius: 7, padding: '4px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>Yes, let&rsquo;s talk</button>
                  <button onClick={() => setDismissedNudges(prev => new Set(prev).add(n.id))} style={{ fontSize: 10.5, color: '#9b9b96', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Not now</button>
                </div>
              </div>
            ))}
          </div>

          {/* Chips */}
          <div style={{ padding: '6px 12px', display: 'flex', gap: 5, flexWrap: 'wrap', flexShrink: 0, borderTop: '1px solid var(--line, #E5E0D5)' }}>
            {chipsToShow.slice(0, 3).map(q => (
              <button key={q} onClick={() => sendMessage(q)} style={{ fontSize: 10.5, background: '#f5f5f3', border: '1px solid rgba(0,0,0,0.09)', borderRadius: 14, padding: '4px 9px', cursor: 'pointer', color: '#6b6b67', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>{q}</button>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding: '8px 12px 10px', display: 'flex', gap: 6, flexShrink: 0 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } }}
              placeholder="Ask your coach…"
              style={{ flex: 1, border: '1px solid var(--line, #E5E0D5)', borderRadius: 10, padding: '8px 11px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', background: '#faf8f3' }}
            />
            <button onClick={() => sendMessage()} disabled={!input.trim() || streaming} style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: input.trim() && !streaming ? 'var(--primary, #1B6B3A)' : '#e5e0d5', color: '#fff', cursor: input.trim() ? 'pointer' : 'default', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* Floating trigger */}
      {open ? (
        <button
          onClick={toggleOpen}
          title="Close"
          style={{ width: 52, height: 52, borderRadius: '50%', border: 'none', background: 'var(--primary, #1B6B3A)', color: '#fff', cursor: 'pointer', display: 'grid', placeItems: 'center', boxShadow: '0 6px 20px rgba(15,74,38,.32), 0 2px 6px rgba(15,74,38,.24)' }}
        >
          <span style={{ fontSize: 18 }}>✕</span>
        </button>
      ) : (
        <button
          onClick={toggleOpen}
          style={{
            height: 52, borderRadius: 26,
            background: 'var(--primary, #1B6B3A)', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px 0 16px',
            boxShadow: '0 6px 20px rgba(15,74,38,.32), 0 2px 6px rgba(15,74,38,.24)',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
            <circle cx="12" cy="12" r="4" />
          </svg>
          <span style={{ color: '#fff', fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}>
            Ask your AI coach
          </span>
        </button>
      )}
    </div>
  );
}
