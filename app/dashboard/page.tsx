'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';

type Role = 'Owner' | 'Co-manager' | 'Committee lead';

const NAV_SECTIONS = [
  { label: 'EVENT', items: ['Dashboard', 'Field', 'Sponsors', 'Course setup', 'Contests'] },
  { label: 'DAY-OF', items: ['Live leaderboard', 'Pace of play'] },
  { label: 'POST-EVENT', items: ['Recap & receipts'] },
];

const PHASES = ['Setup', 'Build the field', 'Final prep', 'Day-of', 'Post-event'];

const SETUP_STEPS = [
  { label: 'Event details set', done: true },
  { label: 'Co-managers invited', done: true },
  { label: 'Course confirmed', active: true },
  { label: 'Pricing & registration', done: false },
  { label: 'Sponsor packages', done: false },
];

const PROGRESS_BARS = [
  { label: 'Registration', pct: 23, color: '#4A7BA6', right: '23%' },
  { label: 'Sponsors', pct: 34, color: '#1B6B3A', right: '34%' },
  { label: 'TourneyCircle', pct: 16, color: '#8B6DB3', right: '12 reached' },
];

function SquareIcon({ active, done }: { active?: boolean; done?: boolean }) {
  const stroke = done ? '#1B6B3A' : active ? '#4A7BA6' : '#C8C0B0';
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="15" height="15" rx="3" stroke={stroke} strokeWidth="1.8" fill="none" />
      {done && <path d="M4 8.5l3 3 6-6" stroke="#1B6B3A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function CalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<{ name: string; initials: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>('Owner');
  const [activePhase, setActivePhase] = useState(0);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.replace('/sign-in'); return; }
      const full = user.user_metadata?.full_name || user.email || 'Organizer';
      setUser({
        name: full.split(' ')[0],
        initials: full.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase(),
      });
      setLoading(false);
    });
  }, [router]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--ink)', fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans', system-ui, sans-serif", background: 'var(--cream)', WebkitFontSmoothing: 'antialiased' }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 248, flexShrink: 0, background: '#fff', borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>

        {/* Logo */}
        <div style={{ padding: '20px 20px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 19, color: 'var(--ink)', letterSpacing: '-.01em' }}>
            Tourney<span style={{ color: 'var(--primary)' }}>Coach</span>
          </span>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '14px 0', overflowY: 'auto' }}>
          {NAV_SECTIONS.map(({ label, items }) => (
            <div key={label} style={{ marginBottom: 18 }}>
              <div style={{ padding: '0 20px 7px', fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase' as const, color: '#8A9B93' }}>
                {label}
              </div>
              {items.map(item => {
                const isActive = item === 'Dashboard';
                return (
                  <button key={item} style={{
                    width: '100%', textAlign: 'left', padding: '8px 20px',
                    border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                    fontSize: 13.5, fontWeight: isActive ? 600 : 400,
                    color: isActive ? '#4A7BA6' : 'var(--ink)',
                    background: isActive ? 'rgba(74,123,166,.1)' : 'transparent',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                      <rect x="1" y="1" width="14" height="14" rx="2.5"
                        stroke={isActive ? '#4A7BA6' : '#C8C0B0'} strokeWidth="1.7" fill="none" />
                    </svg>
                    {item}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Viewing As */}
        <div style={{ margin: '0 12px 14px', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#8A9B93', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' as const, marginBottom: 9 }}>
            Viewing as
          </div>
          {(['Owner', 'Co-manager', 'Committee lead'] as Role[]).map(r => (
            <button key={r} onClick={() => setRole(r)} style={{
              width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 8, marginBottom: 2,
              border: 'none', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
              fontSize: 13.5, fontWeight: r === role ? 600 : 400,
              color: r === role ? '#4A7BA6' : 'var(--ink)',
              background: r === role ? 'rgba(74,123,166,.12)' : 'transparent',
              display: 'flex', alignItems: 'center', gap: 9,
            }}>
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ flexShrink: 0 }}>
                <rect x="1" y="1" width="13" height="13" rx="2.5"
                  stroke={r === role ? '#4A7BA6' : '#C8C0B0'} strokeWidth="1.7" fill="none" />
              </svg>
              {r}
            </button>
          ))}
        </div>
      </aside>

      {/* ── Main ── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* Event header */}
        <div style={{ background: '#fff', borderBottom: '1px solid var(--line)', padding: '20px 32px 0' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 27, color: 'var(--ink)', margin: 0, letterSpacing: '-.02em' }}>
              Riverside Charity Classic 2026
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#5C6B62', whiteSpace: 'nowrap', flexShrink: 0 }}>
              <CalIcon />
              Oct 4, 2026 · 14 weeks out
            </div>
          </div>

          {/* Phase tabs */}
          <div style={{ display: 'flex', marginBottom: -1 }}>
            {PHASES.map((phase, i) => {
              const isActive = i === activePhase;
              const isPartial = i === 1 && activePhase === 0;
              return (
                <button key={phase} onClick={() => setActivePhase(i)} style={{
                  padding: '10px 22px 11px', border: 'none', background: 'transparent', cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13.5, fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#4A7BA6' : isPartial ? 'var(--ink)' : '#A0A8A2',
                  borderBottom: isActive ? '2px solid #4A7BA6' : isPartial ? '2px solid var(--line)' : '2px solid transparent',
                  whiteSpace: 'nowrap',
                }}>
                  {i + 1} · {phase}
                </button>
              );
            })}
          </div>
        </div>

        {/* Phase content */}
        <div style={{ flex: 1, padding: '26px 32px', overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>

          {/* ── Phase 1: Setup ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase' as const, color: 'var(--primary)', lineHeight: 1.5 }}>
                Phase 1 —<br />Setup
              </div>
              <div style={{ fontSize: 12.5, color: '#8A9B93' }}>12–16 wks out</div>
            </div>

            {/* Coach card */}
            <div style={{ background: 'rgba(74,123,166,.1)', border: '1px solid rgba(74,123,166,.22)', borderRadius: 12, padding: '15px 18px', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none" style={{ flexShrink: 0 }}>
                  <rect x="1" y="1" width="15" height="15" rx="3" stroke="#4A7BA6" strokeWidth="1.8" fill="none" />
                </svg>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Your game plan</span>
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--ink)' }}>
                You&rsquo;re on track. Next: lock the course and open registration. Most organizers finish setup in 3 sessions.
              </p>
            </div>

            {/* Checklist */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {SETUP_STEPS.map(({ label, done, active }) => (
                <div key={label} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 16px', borderRadius: 10,
                  background: active ? 'rgba(74,123,166,.08)' : '#fff',
                  border: `1px solid ${active ? '#4A7BA6' : 'var(--line)'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <SquareIcon done={done} active={active} />
                    <span style={{
                      fontSize: 14,
                      color: done ? '#8A9B93' : active ? '#4A7BA6' : 'var(--ink)',
                      fontWeight: active ? 600 : 400,
                    }}>
                      {label}
                    </span>
                  </div>
                  {active && (
                    <button style={{
                      fontSize: 13, fontWeight: 600, color: '#4A7BA6',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      fontFamily: "'DM Sans', sans-serif",
                    }}>
                      Start →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ── Phase 2: Build the field ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase' as const, color: 'var(--primary)', lineHeight: 1.5 }}>
                Phase 2 — Build<br />the field
              </div>
              <div style={{ fontSize: 12.5, color: '#8A9B93' }}>Ongoing</div>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, marginBottom: 20, paddingBottom: 18, borderBottom: '1px solid var(--line)' }}>
              <div>
                <div style={{ fontSize: 12.5, color: '#5C6B62', marginBottom: 5 }}>Foursomes registered</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 34, letterSpacing: '-.03em', color: 'var(--ink)', lineHeight: 1 }}>7</div>
                <div style={{ fontSize: 12.5, color: '#8A9B93', marginTop: 4 }}>of 30 goal</div>
              </div>
              <div>
                <div style={{ fontSize: 12.5, color: '#5C6B62', marginBottom: 5 }}>Sponsorship raised</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 34, letterSpacing: '-.03em', color: 'var(--ink)', lineHeight: 1 }}>$8,400</div>
                <div style={{ fontSize: 12.5, color: '#8A9B93', marginTop: 4 }}>of $25k goal</div>
              </div>
            </div>

            {/* Progress bars */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
              {PROGRESS_BARS.map(({ label, pct, color, right }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--ink)', width: 110, flexShrink: 0 }}>{label}</div>
                  <div style={{ flex: 1, height: 7, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
                  </div>
                  <div style={{ fontSize: 12.5, color: '#5C6B62', width: 68, textAlign: 'right' as const, flexShrink: 0 }}>{right}</div>
                </div>
              ))}
            </div>

            {/* Next best action */}
            <div style={{ background: 'rgba(200,160,74,.12)', border: '1.5px solid rgba(200,160,74,.5)', borderRadius: 12, padding: '15px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                  <rect x="1" y="1" width="15" height="15" rx="3" stroke="#C8A04A" strokeWidth="1.8" fill="none" />
                </svg>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--ink)' }}>
                  <strong>Next best action:</strong> 3 past players haven&rsquo;t seen the invite. Send a personal nudge &mdash; foursomes from returning players close 2&times; faster.
                </p>
              </div>
            </div>
          </div>

        </div>
      </main>

    </div>
  );
}
