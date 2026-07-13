'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';

interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
}

interface Conversation {
  id: string;
  title: string;
  tournament_id: string | null;
  updated_at: string;
}

interface Tournament {
  id: string;
  name: string;
  event_date: string;
}

const SUGGESTED_QUESTIONS = [
  'How do I fill my field?',
  'What should I charge per player?',
  'How do I get sponsors?',
  'How much will we raise in Year 1?',
  'What expenses should I plan for?',
  'How does day-of scoring work?',
];

// ── Icons ──────────────────────────────────────────────────────────────────
const CoachIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M7 21V4.2c0-.4.3-.7.7-.6l9.7 2.3c.5.1.6.8.1 1l-5.6 2.7c-.3.1-.3.6 0 .7l3.2 1.6c.5.2.4.9-.1 1L7 16"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const BackIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

// ── Main component ─────────────────────────────────────────────────────────
export default function CoachPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ id: string; name: string; initials: string } | null>(null);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // ── Bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      const u = session?.user;
      if (!u) { router.replace('/sign-in'); return; }

      const fullName = u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Organizer';
      const initials = fullName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase();
      setUser({ id: u.id, name: fullName.split(' ')[0], initials });

      // Load current tournament
      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${u.id}`); } catch { /* */ }

      const fields = 'id, name, event_date';
      let picked: Tournament | null = null;

      if (selectedId) {
        const { data } = await supabase
          .from('tournaments')
          .select(fields)
          .eq('organizer_id', u.id)
          .eq('id', selectedId)
          .maybeSingle();
        picked = data;
      }
      if (!picked) {
        const { data } = await supabase
          .from('tournaments')
          .select(fields)
          .eq('organizer_id', u.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        picked = data;
      }
      if (picked) setTournament(picked);

      // Load conversations
      const token = session!.access_token;
      const res = await fetch('/api/coach/conversations', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const convs = await res.json();
        setConversations(convs);
      }

      setLoading(false);
    }
    load();
  }, [router]);

  // ── Auth token helper ────────────────────────────────────────────────────
  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }

  // ── Load conversation messages ───────────────────────────────────────────
  async function loadConversation(convId: string) {
    setActiveConvId(convId);
    setMessages([]);
    const token = await getToken();
    const res = await fetch(`/api/coach/conversations/${convId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const msgs = await res.json();
      setMessages(msgs);
    }
  }

  // ── New conversation ─────────────────────────────────────────────────────
  function startNewConversation() {
    setActiveConvId(null);
    setMessages([]);
    setInput('');
    inputRef.current?.focus();
  }

  // ── Delete conversation ──────────────────────────────────────────────────
  async function deleteConversation(convId: string) {
    const token = await getToken();
    await fetch('/api/coach/conversations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversationId: convId }),
    });
    setConversations(prev => prev.filter(c => c.id !== convId));
    if (activeConvId === convId) {
      setActiveConvId(null);
      setMessages([]);
    }
  }

  // ── Send message ─────────────────────────────────────────────────────────
  async function sendMessage(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || streaming) return;

    setInput('');
    const userMsg: Message = { role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    setStreaming(true);

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      const token = await getToken();
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch('/api/coach/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: msg,
          conversationId: activeConvId || undefined,
          tournamentId: tournament?.id,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to connect' }));
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: `Sorry, something went wrong: ${err.error}` };
          return copy;
        });
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
                const copy = [...prev];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, content: last.content + data.text };
                return copy;
              });
              if (!activeConvId && data.conversationId) {
                setActiveConvId(data.conversationId);
                setConversations(prev => [
                  { id: data.conversationId, title: msg.slice(0, 80), tournament_id: tournament?.id ?? null, updated_at: new Date().toISOString() },
                  ...prev,
                ]);
              }
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: 'Connection lost. Please try again.' };
          return copy;
        });
      }
    }

    abortRef.current = null;
    setStreaming(false);
  }

  // ── Keyboard handler ─────────────────────────────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── Time formatting ──────────────────────────────────────────────────────
  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--ink)', fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Loading...</p>
      </div>
    );
  }

  const showWelcome = messages.length === 0;

  // ── Styles ──────────────────────────────────────────────────────────────
  const S = {
    page: { display: 'flex', height: '100vh', background: 'var(--cream)', fontFamily: "'DM Sans', system-ui, sans-serif" } as React.CSSProperties,

    // Sidebar
    sidebar: {
      width: sidebarOpen ? 280 : 0, flexShrink: 0, background: '#fff',
      borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column',
      overflow: 'hidden', transition: 'width .2s ease',
    } as React.CSSProperties,
    sidebarHead: {
      padding: '16px 16px 12px', borderBottom: '1px solid var(--line)',
      display: 'flex', alignItems: 'center', gap: 10,
    } as React.CSSProperties,
    newBtn: {
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
      background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10,
      padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
      fontFamily: "'DM Sans', sans-serif",
    } as React.CSSProperties,
    convList: { flex: 1, overflowY: 'auto', padding: '8px 8px' } as React.CSSProperties,
    convItem: (active: boolean) => ({
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
      borderRadius: 10, cursor: 'pointer', marginBottom: 2,
      background: active ? '#EAF2ED' : 'transparent',
      border: active ? '1px solid #C8DDD1' : '1px solid transparent',
    }) as React.CSSProperties,

    // Main
    main: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } as React.CSSProperties,

    // Header
    header: {
      padding: '12px 20px', borderBottom: '1px solid var(--line)', background: '#fff',
      display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
    } as React.CSSProperties,
    headerMark: {
      width: 34, height: 34, borderRadius: 10, background: 'var(--primary)',
      display: 'grid', placeItems: 'center', color: '#fff', flexShrink: 0,
    } as React.CSSProperties,

    // Messages
    msgsWrap: { flex: 1, overflowY: 'auto', padding: '24px 0' } as React.CSSProperties,
    msgsInner: { maxWidth: 760, margin: '0 auto', padding: '0 24px' } as React.CSSProperties,

    // Message bubble
    msgRow: (isUser: boolean) => ({
      display: 'flex', gap: 12, marginBottom: 20,
      flexDirection: isUser ? 'row-reverse' : 'row',
    }) as React.CSSProperties,
    avatar: (isUser: boolean) => ({
      width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
      display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
      background: isUser ? '#EAF2ED' : 'var(--primary)',
      color: isUser ? 'var(--primary)' : '#fff',
      fontFamily: "'Fraunces', serif",
    }) as React.CSSProperties,
    bubble: (isUser: boolean) => ({
      padding: '12px 16px', fontSize: 14.5, lineHeight: 1.65,
      borderRadius: isUser ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
      background: isUser ? 'var(--primary)' : '#fff',
      color: isUser ? '#fff' : 'var(--ink)',
      border: isUser ? 'none' : '1px solid var(--line)',
      maxWidth: '80%', whiteSpace: 'pre-wrap',
      boxShadow: isUser ? 'none' : '0 1px 3px rgba(15,74,38,.04)',
    }) as React.CSSProperties,

    // Input area
    inputWrap: {
      padding: '12px 24px 16px', borderTop: '1px solid var(--line)', background: '#fff',
      flexShrink: 0,
    } as React.CSSProperties,
    inputInner: { maxWidth: 760, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'flex-end' } as React.CSSProperties,
    textarea: {
      flex: 1, border: '1px solid var(--line)', borderRadius: 14, padding: '10px 14px',
      fontSize: 14, fontFamily: "'DM Sans', sans-serif", resize: 'none',
      minHeight: 42, maxHeight: 120, background: 'var(--cream)', color: 'var(--ink)',
      outline: 'none', lineHeight: 1.5,
    } as React.CSSProperties,
    sendBtn: (active: boolean) => ({
      width: 42, height: 42, borderRadius: '50%', border: 'none',
      background: active ? 'var(--primary)' : '#E5E0D5',
      color: active ? '#fff' : '#999', cursor: active ? 'pointer' : 'default',
      display: 'grid', placeItems: 'center', flexShrink: 0,
      transition: 'background .15s',
    }) as React.CSSProperties,

    // Welcome
    welcome: {
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      flex: 1, padding: '40px 24px', textAlign: 'center',
    } as React.CSSProperties,
    welcomeIcon: {
      width: 56, height: 56, borderRadius: 16, background: 'var(--primary)',
      display: 'grid', placeItems: 'center', color: '#fff', marginBottom: 18,
    } as React.CSSProperties,
    chipsWrap: {
      display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
      maxWidth: 560, marginTop: 20,
    } as React.CSSProperties,
    chip: {
      background: '#fff', border: '1px solid var(--line)', borderRadius: 20,
      padding: '8px 16px', fontSize: 13, color: 'var(--ink)', cursor: 'pointer',
      fontFamily: "'DM Sans', sans-serif", fontWeight: 500,
      transition: 'border-color .15s, background .15s',
    } as React.CSSProperties,
  };

  return (
    <div style={S.page}>
      {/* ── Sidebar ── */}
      <div style={S.sidebar}>
        <div style={S.sidebarHead}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--ink)', display: 'flex' }}>
            <BackIcon />
          </button>
          <button onClick={startNewConversation} style={S.newBtn}>
            <PlusIcon /> New chat
          </button>
        </div>

        {tournament && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
            <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 12.5 }}>{tournament.name}</div>
            <div style={{ color: '#5C6B62', marginTop: 2 }}>
              {new Date(tournament.event_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
        )}

        <div style={S.convList}>
          {conversations.length === 0 && (
            <p style={{ color: '#5C6B62', fontSize: 12.5, padding: '12px 8px', textAlign: 'center' }}>
              No conversations yet
            </p>
          )}
          {conversations.map(conv => (
            <div
              key={conv.id}
              style={S.convItem(conv.id === activeConvId)}
              onClick={() => loadConversation(conv.id)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {conv.title}
                </div>
                <div style={{ fontSize: 11, color: '#5C6B62', marginTop: 2 }}>
                  {timeAgo(conv.updated_at)}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#999', opacity: 0.5, transition: 'opacity .15s' }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                title="Delete conversation"
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main chat area ── */}
      <div style={S.main}>
        {/* Header */}
        <div style={S.header}>
          <button
            onClick={() => setSidebarOpen(o => !o)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--ink)', display: 'flex' }}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div style={S.headerMark}><CoachIcon /></div>
          <div>
            <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: 'var(--ink)', letterSpacing: '-.01em' }}>
              AI Coach
            </div>
            <div style={{ fontSize: 12, color: '#5C6B62' }}>
              {tournament ? `Coaching for ${tournament.name}` : 'Your tournament coaching assistant'}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => router.push('/dashboard')}
            style={{
              background: 'none', border: '1px solid var(--line)', borderRadius: 8,
              padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Dashboard
          </button>
        </div>

        {/* Messages or welcome */}
        {showWelcome ? (
          <div style={S.welcome as React.CSSProperties}>
            <div style={S.welcomeIcon}><CoachIcon size={28} /></div>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22, color: 'var(--ink)', margin: '0 0 8px', letterSpacing: '-.02em' }}>
              Hey{user?.name ? `, ${user.name}` : ''}! I&rsquo;m your AI coach.
            </h2>
            <p style={{ color: '#5C6B62', fontSize: 15, maxWidth: 440, lineHeight: 1.6, margin: 0 }}>
              Whether this is your first tournament or your tenth, I&rsquo;m here to help every step of the way. Ask me anything.
            </p>
            <div style={S.chipsWrap as React.CSSProperties}>
              {SUGGESTED_QUESTIONS.map(q => (
                <button
                  key={q}
                  style={S.chip}
                  onClick={() => sendMessage(q)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.background = '#EAF2ED'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.background = '#fff'; }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={S.msgsWrap}>
            <div style={S.msgsInner}>
              {messages.map((msg, i) => (
                <div key={i} style={S.msgRow(msg.role === 'user')}>
                  <div style={S.avatar(msg.role === 'user')}>
                    {msg.role === 'user' ? (user?.initials || 'U') : 'TC'}
                  </div>
                  <div style={S.bubble(msg.role === 'user')}>
                    {msg.content || (streaming && i === messages.length - 1 ? (
                      <span style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#999', animation: 'coachBounce 1.1s infinite' }} />
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#999', animation: 'coachBounce 1.1s infinite .2s' }} />
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#999', animation: 'coachBounce 1.1s infinite .4s' }} />
                      </span>
                    ) : '')}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Input */}
        <div style={S.inputWrap}>
          <div style={S.inputInner}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask your coach anything..."
              rows={1}
              style={S.textarea as React.CSSProperties}
              disabled={streaming}
            />
            <button
              onClick={() => sendMessage()}
              style={S.sendBtn(!!input.trim() && !streaming)}
              disabled={!input.trim() || streaming}
            >
              <SendIcon />
            </button>
          </div>
          <p style={{ textAlign: 'center', fontSize: 11, color: '#999', marginTop: 8 }}>
            TourneyCoach AI &middot; Powered by Claude
          </p>
        </div>
      </div>

      <style>{`
        @keyframes coachBounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-5px); }
        }
      `}</style>
    </div>
  );
}
