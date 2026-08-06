'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';
import { formatEventDate } from '@/lib/formatEventDate';

interface Tournament {
  id: string;
  name: string;
  event_date: string;
  format: string;
  max_players: number;
  cause_story: string | null;
  status: string;
  course_id: string | null;
  fundraising_goal_cents: number | null;
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
// Through the shared helper: `event_date` is a DATE with no zone, so
// `new Date("2026-08-27")` is UTC midnight and renders as Aug 26 for every
// organizer west of UTC — on their own dashboard, about their own tournament.
// Fixed in three emails on Day 28; the browser pages were never converted.
function fmtDate(d: string) {
  return formatEventDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
}
// Tile-sized money. At 40px there is no room for cents, and "$10,500" already
// tells the organizer everything "$10,500.00" would.
function fmtShortMoney(cents: number): string {
  const dollars = Math.round(cents / 100);
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(dollars % 1_000_000 === 0 ? 0 : 1)}M`;
  if (dollars >= 10_000) return `$${(dollars / 1000).toFixed(dollars % 1000 === 0 ? 0 : 1)}k`;
  return `$${dollars.toLocaleString('en-US')}`;
}

function fmtFormat(f: string) {
  const m: Record<string, string> = { scramble: 'Scramble', best_ball: 'Best Ball', stableford: 'Stableford', captains_choice: "Captain's Choice" };
  return m[f] ?? f;
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; fullName: string; initials: string; avatar: string; id: string } | null>(null);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [allTournaments, setAllTournaments] = useState<Tournament[]>([]);
  const [registrationCount, setRegistrationCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [coachRefresh, setCoachRefresh] = useState(0);
  const [storyDone, setStoryDone] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const [phase2CoachDismissed, setPhase2CoachDismissed] = useState(false);
  const [lastCourseId, setLastCourseId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // Real completion signals for the game-plan spine, so the "you're here"
  // marker moves as data accumulates instead of being pinned to step 4.
  const [progress, setProgress] = useState({ sponsors: false, volunteers: false, dayOf: false });
  // The Stage 2 money tiles. These were hardcoded to $0 / 0 / "none yet" — three
  // static literals on the organizer's primary dashboard, so a tournament that
  // had banked ten thousand dollars still read "Raised so far $0 · Sponsors 0 ·
  // none yet". The Field-filled tile beside them was live the whole time, which
  // is what made it read as truth rather than as a placeholder.
  const [money, setMoney] = useState({ raisedCents: 0, sponsorCount: 0, committedCents: 0 });

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/sign-in');
  };

  async function switchTournament(t: Tournament) {
    setTournament(t);
    setSwitchOpen(false);
    if (user) {
      try { localStorage.setItem(`tourney_selected_tournament_${user.id}`, t.id); } catch { /* */ }
    }
    const { count } = await supabase
      .from('registrations')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', t.id)
      .in('payment_status', ['pending', 'paid']);
    setRegistrationCount(count ?? 0);
  }

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
      setUser({ name: firstName, fullName, initials, avatar, id: u.id });

      // GPS pipeline is an internal surface — only surface its shortcut to
      // admins, so a regular organizer never sees a button that walls them off.
      supabase.from('profiles').select('role').eq('id', u.id).maybeSingle()
        .then(({ data }) => setIsAdmin(data?.role === 'admin'));

      try {
        const saved = localStorage.getItem(`tourney_story_${u.id}`);
        if (saved) {
          const story = JSON.parse(saved);
          setStoryDone(Object.values(story).some((v) => (v as string)?.trim?.()));
        }
      } catch { /* ignore */ }

      try { setLastCourseId(localStorage.getItem(`tourney_last_course_${u.id}`)); } catch { /* ignore */ }

      // The top bar shows whichever tournament was last picked in the
      // Registrations dropdown, so switching there stays consistent when you
      // come back to the dashboard — not just always the newest tournament.
      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${u.id}`); } catch { /* ignore */ }

      const fields = 'id, name, event_date, format, max_players, cause_story, status, course_id, fundraising_goal_cents';
      let picked = null as Tournament | null;

      if (selectedId) {
        const { data } = await supabase
          .from('tournaments')
          .select(fields)
          .eq('organizer_id', u.id)
          .eq('id', selectedId)
          .maybeSingle();
        picked = data;
      }

      // No saved selection, or it no longer belongs to this organizer (e.g. deleted) — fall back to newest
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

      // Load all tournaments for the switcher
      const { data: allT } = await supabase
        .from('tournaments')
        .select(fields)
        .eq('organizer_id', u.id)
        .order('created_at', { ascending: false });
      if (allT) setAllTournaments(allT);

      if (picked) {
        const data = picked;
        setTournament(data);
        const { count } = await supabase
          .from('registrations')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', data.id)
          .in('payment_status', ['pending', 'paid']);
        setRegistrationCount(count ?? 0);

        // Spine progress, from the same definitions the rest of the app uses:
        // a sponsor counts once committed (verbal handshake included — the
        // goals dashboard's rule), volunteers count from day-of signups or a
        // committee member, and the day-of plan counts once any foursome has
        // a starting hole.
        const [spon, signups, holes, sponsorRows, paidRegs] = await Promise.all([
          supabase.from('sponsors').select('id', { count: 'exact', head: true })
            .eq('tournament_id', data.id).in('status', ['verbal', 'invoiced', 'paid']),
          supabase.from('volunteer_signups').select('id', { count: 'exact', head: true })
            .eq('tournament_id', data.id),
          supabase.from('registrations').select('id', { count: 'exact', head: true })
            .eq('tournament_id', data.id).not('starting_hole', 'is', null),
          // Committed sponsorship uses the same rule as the goals dashboard —
          // verbal handshakes count toward progress; declined never does.
          supabase.from('sponsors').select('amount_cents, status')
            .eq('tournament_id', data.id).in('status', ['verbal', 'invoiced', 'paid']),
          // "Raised" is money actually collected, so entry fees only count once
          // paid. A pending card is not raised.
          supabase.from('registrations').select('total_amount_cents')
            .eq('tournament_id', data.id).eq('payment_status', 'paid'),
        ]);

        const sponsorRowsData = sponsorRows.data ?? [];
        const committedCents = sponsorRowsData.reduce((n, r) => n + (r.amount_cents ?? 0), 0);
        const sponsorCashCents = sponsorRowsData
          .filter((r) => r.status === 'paid')
          .reduce((n, r) => n + (r.amount_cents ?? 0), 0);
        const entryCents = (paidRegs.data ?? []).reduce((n, r) => n + (r.total_amount_cents ?? 0), 0);
        setMoney({
          raisedCents: sponsorCashCents + entryCents,
          sponsorCount: spon.count ?? 0,
          committedCents,
        });
        let volunteers = (signups.count ?? 0) > 0;
        if (!volunteers) {
          // Committee members built on /team live behind an owner-checked API
          // (their tables are service-role only) — ask it rather than guess.
          try {
            const res = await authedFetch(`/api/tournament/${data.id}/team`);
            if (res.ok) {
              const t = await res.json();
              volunteers = ((t.summary?.planningFilled ?? 0) + (t.summary?.dayOfFilled ?? 0)) > 0;
            }
          } catch { /* stay false */ }
        }
        setProgress({
          sponsors: (spon.count ?? 0) > 0,
          volunteers,
          dayOf: (holes.count ?? 0) > 0,
        });
      }
      setLoading(false);
    }
    load();
  }, [router, coachRefresh]);

  // When the AI coach changes the event on the organizer's behalf, refetch so
  // the dashboard's live figures (field size, format, status, goal…) update
  // immediately — no reload needed.
  useEffect(() => {
    const onCoachAction = () => setCoachRefresh(n => n + 1);
    window.addEventListener('tc-coach-action', onCoachAction);
    return () => window.removeEventListener('tc-coach-action', onCoachAction);
  }, []);

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
    // Both of these go where the matching dashboard button goes, so a step in
    // the spine and its button are never two different destinations.
    { label: 'Open registration', done: (tournament?.status ?? 'draft') !== 'draft' || registrationCount > 0, href: setupDone ? '/dashboard/registrations' : null },
    { label: 'Line up your sponsors', done: progress.sponsors, href: '/sponsors' },
    { label: 'Rally your volunteers', done: progress.volunteers, href: '/dashboard/volunteers' },
    { label: 'Build your day-of game plan', done: progress.dayOf, href: '/shotgun' },
  ];
  const activeIdx = steps.findIndex(s => !s.done);

  const weeks = tournament ? weeksUntil(tournament.event_date) : null;
  const days = tournament ? daysUntil(tournament.event_date) : null;
  const foursomes = tournament ? Math.floor(tournament.max_players / 4) : 18;
  const foursomesFilled = registrationCount;
  const goalCents = tournament?.fundraising_goal_cents ?? 0;
  const raisedPct = goalCents > 0 ? Math.min(100, Math.round((money.raisedCents / goalCents) * 100)) : 0;
  // This tournament's own course. Open its builder if it has one; otherwise
  // start a new course and link it back to this tournament on save.
  const courseHref = tournament?.course_id
    ? `/course/${tournament.course_id}`
    : `/course/new${tournament ? `?tournament=${tournament.id}` : ''}`;

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
    topbar: { display: 'flex', alignItems: 'center', gap: 14, rowGap: 10, flexWrap: 'wrap', padding: '10px 20px', background: '#fff', border: '1px solid var(--line)', borderRadius: 16, boxShadow: '0 1px 3px rgba(15,74,38,.06), 0 8px 28px rgba(15,74,38,.08)', overflow: 'visible', minWidth: 0 },
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
        <div className="tc-topbar" style={s.topbar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={s.mark}><CoachIcon color="#fff" size={20} /></span>
            <span style={s.brandName}>Tourney<span style={{ color: 'var(--primary)' }}>Coach</span></span>
          </div>

          {tournament && (
            <div style={{ ...s.tourney, position: 'relative' }}>
              <button
                onClick={() => setSwitchOpen(o => !o)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <div>
                  <div style={s.tName}>{tournament.name}</div>
                  <div style={s.tMeta}>
                    {fmtDate(tournament.event_date)}
                    {' · '}{fmtFormat(tournament.format)}
                    {' · '}{tournament.max_players} players
                  </div>
                </div>
                {allTournaments.length > 1 && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: '#5C6B62', flexShrink: 0 }}>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>

              {switchOpen && allTournaments.length > 1 && (
                <>
                  <div onClick={() => setSwitchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                  <div style={{ position: 'absolute', left: 0, top: 'calc(100% + 8px)', background: '#fff', border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 4px 20px rgba(15,74,38,.12)', minWidth: 260, zIndex: 20, overflow: 'hidden' }}>
                    <div style={{ padding: '8px 12px 6px', fontSize: 10.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#5C6B62' }}>
                      Switch event
                    </div>
                    {allTournaments.map(t => (
                      <button
                        key={t.id}
                        onClick={() => switchTournament(t)}
                        style={{
                          width: '100%', padding: '10px 14px', background: t.id === tournament.id ? '#EAF2ED' : 'transparent',
                          border: 'none', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                          fontFamily: "'DM Sans', sans-serif", transition: 'background .1s',
                        }}
                        onMouseEnter={e => { if (t.id !== tournament.id) e.currentTarget.style.background = '#f5f5f0'; }}
                        onMouseLeave={e => { if (t.id !== tournament.id) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: t.id === tournament.id ? 'var(--primary)' : 'var(--line)', flexShrink: 0 }} />
                        <div>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{t.name}</div>
                          <div style={{ fontSize: 11.5, color: '#5C6B62', marginTop: 1 }}>
                            {fmtDate(t.event_date)} · {fmtFormat(t.format)}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }} />

          {tournament && (
            <div className="tc-topbar-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                onClick={() => router.push('/dashboard/volunteers')}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                Volunteers
              </button>
              <button
                onClick={() => router.push('/dashboard/microsite')}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                Microsite
              </button>
              <button
                onClick={() => router.push('/dashboard/share')}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
                Share
              </button>
              <button
                onClick={() => router.push('/shotgun')}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" />
                </svg>
                Shotgun Start
              </button>
              <button
                onClick={() => router.push(courseHref)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                </svg>
                Course Builder
              </button>
              <button
                onClick={() => router.push('/contests')}
                title="Hole-in-one, closest-to-pin, longest drive, putting contest"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v7" /><circle cx="12" cy="14" r="6" /><path d="M9 20h6" />
                </svg>
                Contest Holes
              </button>
              <button
                onClick={() => router.push('/circle')}
                title="TourneyCircle — reach opted-in charitable golfers near your course"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
                </svg>
                TourneyCircle
              </button>
              <button
                onClick={() => router.push('/preview/hole-map')}
                title="Tag each hole's layout and features — generates the hole map players see"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" /><line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" />
                </svg>
                Hole Map
              </button>
              <button
                onClick={() => router.push('/team')}
                title="Build your planning committee and day-of crew — invite by email or text"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                Your Team
              </button>
              <button
                onClick={() => router.push('/goals')}
                title="Your five tournament goals — players, sponsorship, donations, reach, volunteer roles"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.5" />
                </svg>
                Tournament Goals
              </button>
              <button
                onClick={() => router.push('/fb')}
                title="Weather-adjusted beer, water, snack and lunch quantities, plus kitchen prep timing"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 2v7a3 3 0 0 0 3 3v10" /><path d="M9 2v6" /><path d="M18 2a3 4 0 0 0-3 4v6h3v10" />
                </svg>
                F&amp;B Calculator
              </button>
              <button
                onClick={() => router.push('/fb?tab=donations')}
                title="Vendor prospects, AI-drafted donation requests, call scripts, tax letters and the donor wall"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 12v9H4v-9" /><rect x="2" y="7" width="20" height="5" rx="1" /><path d="M12 21V7" />
                  <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
                </svg>
                Vendor Donations
              </button>
              <button
                onClick={() => router.push('/dayof')}
                title="Live board for tournament day — who has arrived, where they are, what is overdue, and the crew alerts"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M8 4v16" />
                </svg>
                Day-of Board
              </button>
              <button
                onClick={() => router.push('/pace')}
                title="Where every group is, and when the last one finishes — the kitchen is texted automatically"
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                </svg>
                Pace of Play
              </button>
              {(
                <button
                  onClick={() => router.push('/tv/leaderboard')}
                  title="Open your clubhouse TV leaderboard (full-screen, auto-updating)"
                  style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
                  </svg>
                  TV Leaderboard
                </button>
              )}
              {isAdmin && (
                <button
                  onClick={() => router.push('/admin/pipeline/gps')}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--primary)', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  GPS
                </button>
              )}
            </div>
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
          <p style={s.stripP}>Your organizer dashboard re-weights itself as the event moves</p>
        </div>

        {/* ── Two-phase grid ── */}
        <div className="tc-two-col" style={s.grid}>

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
                          {href ? (
                            <a href={href} onClick={e => { e.preventDefault(); router.push(href); }} style={{ color: isNow ? 'var(--ink)' : '#5C6B62', textDecoration: 'none' }}>
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
                <p style={{ fontSize: 12.5, color: '#5C6B62', margin: '0 0 8px' }}>Running this solo? That&rsquo;s how most great tournaments start.</p>
                <div style={s.teamline}>
                  <span style={s.chip}>
                    <span style={s.chipAvi}>{user?.initials}</span>
                    <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>You</strong>
                    <span style={{ color: '#5C6B62', fontWeight: 400 }}>&middot; everything</span>
                  </span>
                  <button style={s.addBtn} onClick={() => router.push('/team')}>+ Invite someone to help</button>
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
              <div className="tc-tiles" style={s.tiles}>
                <div style={s.tileLead}>
                  <div style={s.tileLab}>Field filled</div>
                  <div style={s.tileNum}>{foursomesFilled}<span style={{ fontSize: 16, opacity: .8, fontWeight: 400 }}> / {foursomes}</span></div>
                  <div style={s.tileSub}>foursomes · {foursomes - foursomesFilled} to go</div>
                  <div style={s.bar}><span style={{ display: 'block', height: '100%', borderRadius: 999, background: 'var(--gold)', width: `${Math.min(100, (foursomesFilled / foursomes) * 100)}%` }} /></div>
                </div>
                <div style={s.tileLead}>
                  <div style={s.tileLab}>Raised so far</div>
                  <div style={s.tileNum}>{fmtShortMoney(money.raisedCents)}</div>
                  <div style={s.tileSub}>
                    {goalCents
                      ? `of ${fmtShortMoney(goalCents)} goal`
                      : money.raisedCents > 0 ? 'set a goal on Tournament Goals' : 'no goal set yet'}
                  </div>
                  <div style={s.bar}><span style={{ display: 'block', height: '100%', borderRadius: 999, background: 'var(--gold)', width: `${raisedPct}%` }} /></div>
                </div>
                <div style={s.tileBase}>
                  <div style={s.tileLabDark}>Sponsors</div>
                  <div style={s.tileNumGreen}>{money.sponsorCount}</div>
                  <div style={s.tileSubDark}>
                    {money.sponsorCount === 0
                      ? 'none yet'
                      : `${fmtShortMoney(money.committedCents)} committed`}
                  </div>
                </div>
                <div style={s.tileBase}>
                  <div style={s.tileLabDark}>Days left</div>
                  <div style={s.tileNumGreen}>{days ?? '—'}</div>
                  <div style={s.tileSubDark}>{tournament ? `tee off ${fmtDate(tournament.event_date)}` : 'set up event first'}</div>
                </div>
              </div>

              {/* Coach card */}
              {!phase2CoachDismissed && (
                <div style={s.coach}>
                  <div style={s.coachEy}>
                    <span style={s.coachPin}><CoachIcon /></span>
                    <span style={s.coachLabel}>From your coach</span>
                  </div>
                  <div style={s.coachMsg}>
                    {setupDone
                      ? <>You&rsquo;re ready to build the field. Open registration and start reaching out to sponsors — both happen in parallel.</>
                      : <>Finish Phase 1 first. Once your event details are locked in, <strong style={{ color: 'var(--gold)' }}>registration</strong> opens up automatically.</>
                    }
                  </div>
                  <div style={s.coachActs}>
                    {setupDone
                      ? <button style={s.btnGold} onClick={() => router.push(`/register?id=${tournament!.id}`)}>Open registration</button>
                      : <button style={s.btnGold} onClick={() => steps[activeIdx]?.href && router.push(steps[activeIdx].href!)}>
                          Complete Phase 1 first
                        </button>
                    }
                    <button style={s.btnGhost} onClick={() => setPhase2CoachDismissed(true)}>Maybe later</button>
                  </div>
                </div>
              )}

              {/* 347 widget */}
              <div style={s.circle}>
                <div style={s.circleBig}>347</div>
                <div style={{ fontSize: 13 }}>
                  <div>golfers within 35 miles want to hear about tournaments like yours.</div>
                  <div style={{ fontSize: 11, color: '#5C6B62', marginTop: 3 }}>One message, sent for you — about 1 in 4 click through. We never share their names or emails.</div>
                </div>
              </div>

              {/* Jump back in */}
              <div>
                <p style={s.blockH}>Jump back in</p>
                <div className="tc-quick" style={s.quick}>
                  {[
                    { label: 'Cause story', sub: causeStoryDone ? 'done' : 'not started', href: '/story' },
                    { label: 'Event setup', sub: setupDone ? 'done' : 'not started', href: '/setup/format' },
                    { label: 'Registration', sub: setupDone ? 'view registrations' : 'not started', href: setupDone ? '/dashboard/registrations' : null },
                    { label: 'Sponsors', sub: setupDone ? 'view sponsors' : 'not started', href: setupDone ? '/sponsors' : null },
                    { label: 'Shotgun start', sub: setupDone ? 'assign holes' : 'not started', href: setupDone ? '/shotgun' : null },
                    { label: 'Course profile', sub: tournament?.course_id ? 'resume building' : 'build a course', href: courseHref },
                    // Everything in the toolbar above also lives here, so the
                    // grid is the one complete index of the dashboard rather
                    // than a shortlist that quietly falls behind it.
                    { label: 'Your team', sub: 'committee and crew', href: '/team' },
                    { label: 'Volunteers', sub: 'day-of signups', href: '/dashboard/volunteers' },
                    { label: 'Tournament goals', sub: 'track your five', href: '/goals' },
                    { label: 'F&B calculator', sub: 'weather-adjusted quantities', href: '/fb' },
                    { label: 'Vendor donations', sub: 'prospects and outreach', href: '/fb?tab=donations' },
                    { label: 'Day-of board', sub: 'live crew operations', href: '/dayof' },
                    { label: 'Pace of play', sub: 'where every group is', href: '/pace' },
                    { label: 'Contest holes', sub: 'hole-in-one and more', href: '/contests' },
                    { label: 'Hole map', sub: 'tag each hole', href: '/preview/hole-map' },
                    { label: 'TourneyCircle', sub: 'reach nearby golfers', href: '/circle' },
                    { label: 'Microsite', sub: 'your public page', href: '/dashboard/microsite' },
                    { label: 'Share', sub: 'graphics and links', href: '/dashboard/share' },
                    { label: 'TV leaderboard', sub: 'clubhouse screen', href: '/tv/leaderboard' },
                    ...(isAdmin ? [{ label: 'GPS pipeline', sub: 'admin', href: '/admin/pipeline/gps' }] : []),
                  ].map(({ label, sub, href }) => (
                    <button key={label} style={s.q} onClick={() => href && router.push(href)} disabled={!href}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--ink)' }}>{label}</div>
                      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11, color: '#5C6B62', marginTop: 3, fontWeight: 500 }}>{sub}</div>
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </section>

        </div>

        <footer style={s.footer}>
          <strong style={{ color: 'var(--primary)' }}>TourneyCoach</strong>&nbsp;&middot;&nbsp;Organizer Dashboard
        </footer>

      </div>
    </div>
  );
}
