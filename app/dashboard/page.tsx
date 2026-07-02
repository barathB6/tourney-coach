'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';

interface Tournament {
  id: string;
  name: string;
  event_date: string;
  format: string;
  max_players: number;
  cause_story: string | null;
}

// ── Icons ──────────────────────────────────────────────────────────────────
const CoachIcon = ({ color = '#A9D9BD', size = 13 }: { color?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M7 21V4.2c0-.4.3-.7.7-.6l9.7 2.3c.5.1.6.8.1 1l-5.6 2.7c-.3.1-.3.6 0 .7l3.2 1.6c.5.2.4.9-.1 1L7 16"
      stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── Helpers ────────────────────────────────────────────────────────────────
function daysUntil(dateStr: string) {
  return Math.max(0, Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000));
}
function weeksUntil(dateStr: string) {
  return Math.max(0, Math.round(daysUntil(dateStr) / 7));
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtFormat(f: string) {
  const m: Record<string, string> = { scramble: 'Scramble', best_ball: 'Best Ball', stableford: 'Stableford', captains_choice: "Captain's Choice" };
  return m[f] ?? f;
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; fullName: string; initials: string; avatar: string } | null>(null);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [registrationCount, setRegistrationCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [storyDone, setStoryDone] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/sign-in');
  };

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      const u = session?.user ?? null;
      if (!u) { router.replace('/sign-in'); return; }

      const fullName = u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Organizer';
      const firstName = fullName.split(' ')[0];
      const initials = fullName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase();
      const avatar = u.user_metadata?.avatar_url || u.user_metadata?.picture || '';
      console.log('[Dashboard] user_metadata:', u.user_metadata, '| avatar:', avatar);
      setUser({ name: firstName, fullName, initials, avatar });

      try {
        const saved = localStorage.getItem(`tourney_story_${u.id}`);
        if (saved) {
          const story = JSON.parse(saved);
          setStoryDone(Object.values(story).some((v) => (v as string)?.trim?.()));
        }
      } catch { /* ignore */ }

      const { data } = await supabase
        .from('tournaments')
        .select('id, name, event_date, format, max_players, cause_story')
        .eq('organizer_id', u.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) {
        setTournament(data);
        const { count } = await supabase
          .from('registrations')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', data.id)
          .in('payment_status', ['pending', 'paid']);
        setRegistrationCount(count ?? 0);
      }
      setLoading(false);
    }
    load();
  }, [router]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--ink)', fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Loading…</p>
      </div>
    );
  }

  const setupDone = !!tournament;
  const causeStoryDone = storyDone || !!tournament?.cause_story;

  // First incomplete step
  const steps = [
    { label: 'Tell your cause story', done: causeStoryDone, href: '/story' },
    { label: 'Set up the event details', done: setupDone, href: '/setup/format' },
    { label: 'Open registration', done: false, href: null },
    { label: 'Line up your sponsors', done: false, href: null },
    { label: 'Rally your volunteers', done: false, href: null },
    { label: 'Build your day-of game plan', done: false, href: null },
  ];
  const activeIdx = steps.findIndex(s => !s.done);

  const weeks = tournament ? weeksUntil(tournament.event_date) : null;
  const days = tournament ? daysUntil(tournament.event_date) : null;
  const foursomes = tournament ? Math.floor(tournament.max_players / 4) : 18;
  const foursomesFilled = registrationCount;

  const coachMsg = activeIdx === 0
    ? `Welcome back, ${user?.name}. The heart of every great tournament is the story of why. Let's write yours first — it's what makes sponsors say yes and players show up.`
    : activeIdx === 1
    ? `Cause story locked in, ${user?.name}. Now set up your event details — format, field size, date, and pricing. Most organizers finish this in one session.`
    : `You're building momentum, ${user?.name}. Keep going — the next step is small enough to finish before lunch.`;

  const coachBtnLabel = activeIdx === 0 ? 'Start your cause story' : activeIdx === 1 ? 'Set up event details' : 'Continue';
  const coachBtnHref = steps[activeIdx]?.href;

  // ── Style tokens ──────────────────────────────────────────────────────────
  const s: Record<string, React.CSSProperties> = {
    page: { minHeight: '100vh', background: 'var(--cream)', fontFamily: "'DM Sans', system-ui, sans-serif", WebkitFontSmoothing: 'antialiased' },
    wrap: { maxWidth: 1180, margin: '0 auto', padding: '28px 22px 56px' },

    // Top bar
    topbar: { display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '16px 20px', background: '#fff', border: '1px solid var(--line)', borderRadius: 16, boxShadow: '0 1px 3px rgba(15,74,38,.06), 0 8px 28px rgba(15,74,38,.08)' },
    mark: { width: 38, height: 38, flexShrink: 0, borderRadius: 11, background: 'var(--primary)', display: 'grid', placeItems: 'center' },
    brandName: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 19, letterSpacing: '-.02em', color: 'var(--ink)' },
    tourney: { paddingLeft: 18, borderLeft: '1px solid var(--line)' },
    tName: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 16, lineHeight: 1.2, color: 'var(--ink)' },
    tMeta: { fontSize: 12.5, color: '#5C6B62', marginTop: 2 },
    avi: { width: 32, height: 32, borderRadius: '50%', background: '#EAF2ED', color: 'var(--primary)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, border: '1px solid var(--line)', fontFamily: "'Fraunces', serif", flexShrink: 0 },

    // Strip
    strip: { margin: '18px 2px 14px', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
    stripH1: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 20, margin: 0, letterSpacing: '-.02em', color: 'var(--ink)' },
    stripP: { margin: 0, color: '#5C6B62', fontSize: 13.5 },

    // Grid
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 },
    phase: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, boxShadow: '0 1px 3px rgba(15,74,38,.06), 0 8px 28px rgba(15,74,38,.08)', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
    phead: { padding: '15px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottom: '1px solid var(--line)' },
    ptag: { fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase' as const, color: 'var(--primary)', background: '#EAF2ED', padding: '4px 10px', borderRadius: 999 },
    clock: { fontSize: 12.5, color: '#5C6B62', fontWeight: 600, whiteSpace: 'nowrap' },
    pbody: { padding: 18, display: 'flex', flexDirection: 'column', gap: 16, flex: 1 },

    // Coach card
    coach: { background: 'var(--deep-green)', color: '#fff', borderRadius: 14, padding: '16px 16px 15px', position: 'relative', overflow: 'hidden' },
    coachEy: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 },
    coachPin: { width: 22, height: 22, flexShrink: 0, borderRadius: 7, background: 'rgba(255,255,255,.12)', display: 'grid', placeItems: 'center' },
    coachLabel: { fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase' as const, color: '#A9D9BD' },
    coachMsg: { fontSize: 14.5, lineHeight: 1.5, position: 'relative', zIndex: 1 },
    coachActs: { display: 'flex', gap: 9, marginTop: 14, flexWrap: 'wrap', position: 'relative', zIndex: 1 },
    btnGold: { fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 13.5, border: 'none', cursor: 'pointer', borderRadius: 10, padding: '9px 15px', background: 'var(--gold)', color: '#2e1f04' },
    btnGhost: { fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 13.5, cursor: 'pointer', borderRadius: 10, padding: '9px 15px', background: 'transparent', color: '#CFE9D8', border: '1px solid rgba(255,255,255,.28)' },

    // Spine
    blockH: { fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase' as const, color: '#5C6B62', margin: '0 0 2px' },

    // Tiles
    tiles: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
    tileLead: { border: '1px solid var(--primary)', borderRadius: 12, padding: '12px 13px', background: 'var(--primary)', color: '#fff' },
    tileBase: { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 13px', background: '#fff' },
    tileLab: { fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,.8)' },
    tileLabDark: { fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: '#5C6B62' },
    tileNum: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 26, lineHeight: 1.05, marginTop: 5, letterSpacing: '-.02em', color: '#fff' },
    tileNumGreen: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 26, lineHeight: 1.05, marginTop: 5, letterSpacing: '-.02em', color: 'var(--primary)' },
    tileSub: { fontSize: 11.5, color: 'rgba(255,255,255,.8)', marginTop: 2 },
    tileSubDark: { fontSize: 11.5, color: '#5C6B62', marginTop: 2 },
    bar: { height: 6, borderRadius: 999, background: 'rgba(255,255,255,.25)', marginTop: 9, overflow: 'hidden' },

    // Note
    note: { background: '#EAF2ED', border: '1px solid #C8DDD1', borderRadius: 12, padding: '13px 14px', fontSize: 13, color: '#2c4537' },

    // Circle
    circle: { border: '1px solid var(--line)', borderRadius: 12, padding: 14, display: 'flex', gap: 13, alignItems: 'flex-start' },
    circleBig: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 30, color: 'var(--primary)', lineHeight: 1, letterSpacing: '-.02em', flexShrink: 0 },

    // Quick
    quick: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 9 },
    q: { border: '1px solid var(--line)', borderRadius: 11, padding: '11px 10px', textAlign: 'left', background: '#fff', cursor: 'pointer' },

    // Team
    teamline: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: '#5C6B62' },
    chip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#fff', border: '1px solid var(--line)', borderRadius: 999, padding: '4px 11px 4px 5px', fontSize: 12.5 },
    chipAvi: { width: 20, height: 20, borderRadius: '50%', background: '#EAF2ED', color: 'var(--primary)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 10, fontFamily: "'Fraunces', serif" },
    addBtn: { border: '1px dashed var(--line)', background: 'transparent', color: 'var(--primary)', borderRadius: 999, padding: '5px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },

    footer: { marginTop: 26, textAlign: 'center', color: '#5C6B62', fontSize: 12, lineHeight: 1.6 },
  };

  return (
    <div style={s.page}>
      <div style={s.wrap}>

        {/* ── Top bar ── */}
        <div style={s.topbar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={s.mark}><CoachIcon color="#fff" size={20} /></span>
            <span style={s.brandName}>Tourney<span style={{ color: 'var(--primary)' }}>Coach</span></span>
          </div>

          {tournament && (
            <div style={s.tourney}>
              <div style={s.tName}>{tournament.name}</div>
              <div style={s.tMeta}>
                {fmtDate(tournament.event_date)}
                {' · '}{fmtFormat(tournament.format)}
                {' · '}{tournament.max_players} players
              </div>
            </div>
          )}

          <div style={{ flex: 1 }} />

          {tournament && (
            <button
              onClick={() => router.push('/dashboard/microsite')}
              style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              Microsite
            </button>
          )}

          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 10 }}
            >
              {user?.avatar && !avatarError ? (
                <img
                  src={user.avatar}
                  alt={user.fullName}
                  width={34}
                  height={34}
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarError(true)}
                  style={{ borderRadius: '50%', border: '2px solid var(--line)', flexShrink: 0, objectFit: 'cover' }}
                />
              ) : (
                <div style={s.avi}>{user?.initials}</div>
              )}
              <div style={{ fontSize: 12.5, color: '#5C6B62', lineHeight: 1.25, textAlign: 'left' }}>
                <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{user?.name}</strong><br />organizer
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ color: '#5C6B62', flexShrink: 0 }}>
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', background: '#fff', border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 4px 20px rgba(15,74,38,.12)', minWidth: 160, zIndex: 20, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{user?.fullName}</div>
                    <div style={{ fontSize: 11, color: '#5C6B62', marginTop: 1 }}>organizer</div>
                  </div>
                  <button
                    onClick={handleSignOut}
                    style={{ width: '100%', padding: '10px 14px', background: 'none', border: 'none', textAlign: 'left', fontSize: 13, color: 'var(--alert)', fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Strip ── */}
        <div style={s.strip}>
          <h1 style={s.stripH1}>One surface, every stage.</h1>
          <p style={s.stripP}>Your organizer dashboard re-weights itself as the event moves. Here are its first two stages, side by side.</p>
        </div>

        {/* ── Two-phase grid ── */}
        <div style={s.grid}>

          {/* ═══ PHASE 1 — SETUP ═══ */}
          <section style={s.phase}>
            <div style={s.phead}>
              <div style={s.ptag}>Stage 1 · Setup</div>
              <div style={s.clock}>{weeks !== null ? `${weeks} weeks to tee off` : '12 weeks to tee off'}</div>
            </div>
            <div style={s.pbody}>

              {/* Coach card */}
              <div style={s.coach}>
                <div style={{ ...s.coach, position: 'absolute', right: -26, bottom: -26, width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,.04)', padding: 0 }} />
                <div style={s.coachEy}>
                  <span style={s.coachPin}><CoachIcon /></span>
                  <span style={s.coachLabel}>From your coach</span>
                </div>
                <div style={s.coachMsg}>
                  {coachMsg.split('why').map((part, i, arr) =>
                    i < arr.length - 1
                      ? <span key={i}>{part}<strong style={{ color: 'var(--gold)' }}>why</strong></span>
                      : <span key={i}>{part}</span>
                  )}
                </div>
                <div style={s.coachActs}>
                  {coachBtnHref && (
                    <button style={s.btnGold} onClick={() => router.push(coachBtnHref)}>
                      {coachBtnLabel}
                    </button>
                  )}
                  <button style={s.btnGhost}>See the whole plan</button>
                </div>
              </div>

              {/* Game plan spine */}
              <div>
                <p style={s.blockH}>Your game plan</p>
                <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, position: 'relative' }}>
                  <li style={{ position: 'absolute', left: 13, top: 10, bottom: 10, width: 2, background: 'var(--line)', pointerEvents: 'none' }} />
                  {steps.map(({ label, done, href }, i) => {
                    const isNow = i === activeIdx;
                    const dotStyle: React.CSSProperties = done
                      ? { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--primary)', display: 'grid', placeItems: 'center', zIndex: 1 }
                      : isNow
                      ? { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: '#fff', border: '2px solid var(--alert)', display: 'grid', placeItems: 'center', zIndex: 1 }
                      : { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: '#fff', border: '2px solid var(--line)', display: 'grid', placeItems: 'center', zIndex: 1, color: '#5C6B62', fontSize: 13, fontWeight: 600 };

                    return (
                      <li key={label} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '7px 0' }}>
                        <span style={dotStyle}>
                          {done ? <CheckIcon /> : isNow ? <CoachIcon color="var(--alert)" /> : i + 1}
                        </span>
                        <span style={{ paddingTop: 4, fontSize: 14, fontWeight: isNow ? 600 : 400, color: done ? '#5C6B62' : isNow ? 'var(--ink)' : '#5C6B62' }}>
                          {isNow && href ? (
                            <a href={href} onClick={e => { e.preventDefault(); router.push(href); }} style={{ color: 'var(--ink)', textDecoration: 'none' }}>
                              {label}
                            </a>
                          ) : label}
                          {isNow && (
                            <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--alert)', border: '1px solid #e7c3ba', background: '#fbeeeb', borderRadius: 999, padding: '2px 7px', marginLeft: 8, verticalAlign: 2 }}>
                              You&rsquo;re here
                            </span>
                          )}
                          {done && (
                            <span style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600, marginLeft: 6 }}>done</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div style={s.note}>
                First-year tournaments usually raise <strong style={{ color: 'var(--ink)' }}>$5,000–$15,000</strong>. We&rsquo;ll take it one step at a time and aim higher together — no rush, no pressure.
              </div>

              <div>
                <p style={s.blockH}>Your team</p>
                <div style={s.teamline}>
                  <span>Running this solo? That&rsquo;s how most great tournaments start.</span>
                  <button style={s.addBtn}>+ Invite someone to help</button>
                </div>
              </div>

            </div>
          </section>

          {/* ═══ PHASE 2 — BUILD THE FIELD ═══ */}
          <section style={s.phase}>
            <div style={s.phead}>
              <div style={s.ptag}>Stage 2 · Build the field &amp; money</div>
              <div style={s.clock}>{days !== null ? `${days} days to tee off` : '38 days to tee off'}</div>
            </div>
            <div style={s.pbody}>

              {/* Stat tiles */}
              <div style={s.tiles}>
                <div style={s.tileLead}>
                  <div style={s.tileLab}>Field filled</div>
                  <div style={s.tileNum}>{foursomesFilled}<span style={{ fontSize: 16, opacity: .8, fontWeight: 400 }}> / {foursomes}</span></div>
                  <div style={s.tileSub}>foursomes · {foursomes - foursomesFilled} to go</div>
                  <div style={s.bar}><span style={{ display: 'block', height: '100%', borderRadius: 999, background: 'var(--gold)', width: `${Math.min(100, (foursomesFilled / foursomes) * 100)}%` }} /></div>
                </div>
                <div style={s.tileLead}>
                  <div style={s.tileLab}>Raised so far</div>
                  <div style={s.tileNum}>$0</div>
                  <div style={s.tileSub}>of goal TBD</div>
                  <div style={s.bar}><span style={{ display: 'block', height: '100%', borderRadius: 999, background: 'var(--gold)', width: '0%' }} /></div>
                </div>
                <div style={s.tileBase}>
                  <div style={s.tileLabDark}>Sponsors</div>
                  <div style={s.tileNumGreen}>0</div>
                  <div style={s.tileSubDark}>none yet</div>
                </div>
                <div style={s.tileBase}>
                  <div style={s.tileLabDark}>Days left</div>
                  <div style={s.tileNumGreen}>{days ?? '—'}</div>
                  <div style={s.tileSubDark}>{tournament ? `tee off ${fmtDate(tournament.event_date)}` : 'set up event first'}</div>
                </div>
              </div>

              {/* Coach card */}
              <div style={s.coach}>
                <div style={s.coachEy}>
                  <span style={s.coachPin}><CoachIcon /></span>
                  <span style={s.coachLabel}>From your coach</span>
                </div>
                <div style={s.coachMsg}>
                  {setupDone
                    ? <>You&rsquo;re ready to build the field. Open registration and start reaching out to sponsors — both happen in parallel.</>
                    : <>Finish Phase 1 first. Once your event details are locked in, <strong style={{ color: 'var(--gold)' }}>registration and sponsors</strong> open up automatically.</>
                  }
                </div>
                <div style={s.coachActs}>
                  {setupDone
                    ? <button style={s.btnGold} onClick={() => router.push(`/register?id=${tournament!.id}`)}>Open registration</button>
                    : <button style={s.btnGold} onClick={() => steps[activeIdx]?.href && router.push(steps[activeIdx].href!)}>
                        Complete Phase 1 first
                      </button>
                  }
                  <button style={s.btnGhost}>Maybe later</button>
                </div>
              </div>

              {/* 347 widget */}
              <div style={s.circle}>
                <div style={s.circleBig}>347</div>
                <div style={{ fontSize: 13 }}>
                  <div>golfers within 35 miles want to hear about tournaments like yours.</div>
                  <div style={{ fontSize: 11, color: '#5C6B62', marginTop: 3 }}>One message, sent for you — about 1 in 4 click through. We never share their names or emails.</div>
                </div>
              </div>

              {/* Progress spine */}
              <div>
                <p style={s.blockH}>Your progress</p>
                <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, position: 'relative' }}>
                  <li style={{ position: 'absolute', left: 13, top: 10, bottom: 10, width: 2, background: 'var(--line)', pointerEvents: 'none' }} />
                  {[
                    { label: 'Cause story', done: causeStoryDone },
                    { label: 'Event set up', done: setupDone },
                    { label: 'Registration & sponsors', done: false, isNow: causeStoryDone && setupDone },
                    { label: 'Rally your volunteers', num: 4 },
                    { label: 'Day-of game plan', num: 5 },
                  ].map(({ label, done, isNow, num }) => {
                    const dotStyle: React.CSSProperties = done
                      ? { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--primary)', display: 'grid', placeItems: 'center', zIndex: 1 }
                      : isNow
                      ? { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: '#fff', border: '2px solid var(--alert)', display: 'grid', placeItems: 'center', zIndex: 1 }
                      : { width: 28, height: 28, flexShrink: 0, borderRadius: '50%', background: '#fff', border: '2px solid var(--line)', display: 'grid', placeItems: 'center', zIndex: 1, color: '#5C6B62', fontSize: 13, fontWeight: 600 };
                    return (
                      <li key={label} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '7px 0' }}>
                        <span style={dotStyle}>
                          {done ? <CheckIcon /> : isNow ? <CoachIcon color="var(--alert)" /> : num}
                        </span>
                        <span style={{ paddingTop: 4, fontSize: 14, fontWeight: (isNow || done) ? 600 : 400, color: done ? 'var(--ink)' : '#5C6B62' }}>
                          {label}
                          {done && <span style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600, marginLeft: 6 }}>done</span>}
                          {isNow && <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--alert)', border: '1px solid #e7c3ba', background: '#fbeeeb', borderRadius: 999, padding: '2px 7px', marginLeft: 8, verticalAlign: 2 }}>You&rsquo;re here</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Jump back in */}
              <div>
                <p style={s.blockH}>Jump back in</p>
                <div style={s.quick}>
                  {[
                    { label: 'Cause story', sub: causeStoryDone ? 'done' : 'not started', href: '/story' },
                    { label: 'Event setup', sub: setupDone ? 'done' : 'not started', href: '/setup/format' },
                    { label: 'Registration', sub: 'coming soon', href: null },
                  ].map(({ label, sub, href }) => (
                    <button key={label} style={s.q} onClick={() => href && router.push(href)} disabled={!href}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--ink)' }}>{label}</div>
                      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: '#5C6B62', marginTop: 3, fontWeight: 500 }}>{sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Team */}
              <div>
                <p style={s.blockH}>Your team</p>
                <div style={s.teamline}>
                  <span style={s.chip}>
                    <span style={s.chipAvi}>{user?.initials}</span>
                    <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>You</strong>
                    <span style={{ color: '#5C6B62', fontWeight: 400 }}>&middot; everything</span>
                  </span>
                  <button style={s.addBtn}>+ Invite</button>
                </div>
              </div>

            </div>
          </section>

        </div>

        <footer style={s.footer}>
          <strong style={{ color: 'var(--primary)' }}>TourneyCoach</strong> &middot; Organizer surface &middot; the same screen in two stages
        </footer>

      </div>
    </div>
  );
}
