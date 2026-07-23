'use client';

import { useEffect, useMemo, useRef, useState, use as usePromise } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Trend = { toPar: number; holes: number; direction: 'up' | 'down' | 'flat' } | null;
type Row = {
  rank: number; tied: boolean; registrationId: string; teamName: string; foursomeNumber: number | null;
  holesCompleted: number; totalStrokes: number; toPar: number | null; players: string[]; trend: Trend;
};
type Board = {
  tournament: { id: string; name: string; format: string; status: string; parTotal: number | null; course: string | null };
  standings: Row[]; teamsTotal: number;
  sponsors: { company: string; logoUrl: string }[];
  contests: { holeNumber: number; type: string; prize: string | null; winner: string | null; detail: string | null; decided: boolean }[];
  raisedCents: number;
};

const FORMAT: Record<string, string> = { scramble: 'Scramble', best_ball: 'Best Ball', alternate_shot: 'Alternate Shot', stroke_play: 'Stroke Play' };
const CONTEST: Record<string, string> = { hole_in_one: 'Hole-in-One', closest_to_pin: 'Closest to Pin', long_drive: 'Long Drive' };
type SortKey = 'score' | 'team' | 'thru';

const toPar = (v: number | null) => (v == null ? '—' : v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export default function TVBoard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [sort, setSort] = useState<SortKey>('score');
  const [sponsorIdx, setSponsorIdx] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/tournament/${id}/board`, { cache: 'no-store' });
        if (!res.ok) { if (active) setError(res.status === 404 ? 'Tournament not found.' : 'Could not load the board.'); return; }
        if (active) { setBoard(await res.json()); setError(''); }
      } catch { if (active) setError('Could not load the board.'); }
    };
    load();
    const channel = supabase.channel(`leaderboard:${id}`).on('broadcast', { event: 'score' }, load).subscribe((s) => active && setLive(s === 'SUBSCRIBED'));
    const poll = setInterval(load, 20_000);
    return () => { active = false; supabase.removeChannel(channel); clearInterval(poll); };
  }, [id]);

  // Rotate sponsor logos every 6s (calm motion; respects reduced-motion).
  const sponsors = board?.sponsors ?? [];
  const reduceMotionRef = useRef(false);
  useEffect(() => { reduceMotionRef.current = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }, []);
  useEffect(() => {
    if (sponsors.length <= 1 || reduceMotionRef.current) return;
    const t = setInterval(() => setSponsorIdx((i) => (i + 1) % sponsors.length), 6000);
    return () => clearInterval(t);
  }, [sponsors.length]);

  const sorted = useMemo(() => {
    const rows = [...(board?.standings ?? [])];
    if (sort === 'team') rows.sort((a, b) => a.teamName.localeCompare(b.teamName));
    else if (sort === 'thru') rows.sort((a, b) => b.holesCompleted - a.holesCompleted || a.rank - b.rank);
    // 'score' keeps the server's ranked order
    return rows;
  }, [board, sort]);

  if (error) return <TVShell><p style={{ color: '#F4C871', fontSize: 28, textAlign: 'center', marginTop: 120 }}>{error}</p></TVShell>;
  if (!board) return <TVShell><p style={{ color: '#9FBFA6', fontSize: 28, textAlign: 'center', marginTop: 120 }}>Loading leaderboard…</p></TVShell>;

  const { tournament, teamsTotal, contests, raisedCents } = board;
  const anyScores = board.standings.some((s) => s.holesCompleted > 0);
  const contestName = (type: string) => CONTEST[type] ?? 'Contest';
  // Only call a contest "decided" once it actually has a winner name — a
  // decided_at with no winner would otherwise print "… · null · Hole 5".
  const decidedContest = contests.find((c) => c.decided && c.winner);
  const openContest = contests.find((c) => !c.decided || !c.winner);
  const contestLine = decidedContest
    ? `${contestName(decidedContest.type)} · ${decidedContest.winner}${decidedContest.detail ? ` (${decidedContest.detail})` : ''} · Hole ${decidedContest.holeNumber}`
    : openContest
      ? `${contestName(openContest.type)} · open · Hole ${openContest.holeNumber}`
      : null;

  return (
    <TVShell>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 'clamp(30px, 4.2vw, 60px)', fontWeight: 700, color: '#fff', margin: 0, lineHeight: 1.05, textWrap: 'balance' }}>{tournament.name}</h1>
          <p style={{ margin: '10px 0 0', color: '#E4B94B', fontSize: 'clamp(13px, 1.5vw, 22px)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {[tournament.course, `${teamsTotal} teams`, tournament.status === 'completed' ? 'Final' : 'Round in progress'].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(228,185,75,0.35)', borderRadius: 12, padding: '10px 18px', flexShrink: 0 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: live ? '#E5533C' : '#6B7775', boxShadow: live ? '0 0 0 4px rgba(229,83,60,0.25)' : 'none' }} />
          <span style={{ color: '#fff', fontSize: 'clamp(12px, 1.3vw, 18px)', fontWeight: 700, letterSpacing: '0.08em' }}>{live ? 'LIVE · UPDATING' : 'RECONNECTING'}</span>
        </div>
      </div>

      {/* sort controls (subtle; the board auto-ranks by score by default) */}
      {anyScores && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['score', 'thru', 'team'] as SortKey[]).map((k) => (
            <button key={k} aria-pressed={sort === k} onClick={() => setSort(k)} style={{ background: sort === k ? 'rgba(228,185,75,0.16)' : 'transparent', color: sort === k ? '#E4B94B' : '#B6D2BC', border: `1px solid ${sort === k ? 'rgba(228,185,75,0.4)' : 'rgba(143,184,154,0.3)'}`, borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              {k === 'score' ? 'By Score' : k === 'thru' ? 'By Thru' : 'By Team'}
            </button>
          ))}
        </div>
      )}

      {!anyScores ? (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: '#9FBFA6' }}>
          <p style={{ fontSize: 'clamp(22px, 3vw, 40px)', fontFamily: "'Fraunces', serif", color: '#fff', margin: '0 0 10px' }}>No scores yet</p>
          <p style={{ fontSize: 'clamp(14px, 1.6vw, 22px)', margin: 0 }}>Standings appear the moment the first team submits a hole.</p>
        </div>
      ) : (
        <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(143,184,154,0.18)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(0,0,0,0.22)' }}>
                {['Pos', 'Team', 'Thru', 'Score', 'Trend'].map((h, i) => (
                  <th key={h} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '14px 24px', color: '#E4B94B', fontSize: 'clamp(11px, 1.1vw, 15px)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((s, i) => (
                <tr key={s.registrationId} style={{ borderTop: '1px solid rgba(143,184,154,0.12)', background: i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={{ padding: '16px 24px', fontFamily: "'Fraunces', serif", fontSize: 'clamp(20px, 2.4vw, 34px)', fontWeight: 700, color: s.rank === 1 ? '#E4B94B' : '#CDE0D2', fontVariantNumeric: 'tabular-nums' }}>
                    {s.holesCompleted === 0 ? '—' : `${s.tied ? 'T-' : ''}${s.rank}`}
                  </td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ fontFamily: "'Fraunces', serif", fontSize: 'clamp(18px, 2vw, 30px)', fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>{s.teamName}</div>
                    {s.players.length > 0 && <div style={{ color: '#8FB89A', fontSize: 'clamp(12px, 1.2vw, 17px)', marginTop: 3 }}>{s.players.join(' · ')}</div>}
                  </td>
                  <td style={{ padding: '16px 24px', textAlign: 'right', color: '#CDE0D2', fontSize: 'clamp(16px, 1.8vw, 26px)', fontVariantNumeric: 'tabular-nums' }}>
                    {s.holesCompleted === 0 ? '—' : s.holesCompleted === 18 ? 'F' : s.holesCompleted}
                  </td>
                  <td style={{ padding: '16px 24px', textAlign: 'right', fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 'clamp(22px, 2.6vw, 40px)', color: (s.toPar ?? 0) < 0 ? '#E4B94B' : '#fff', fontVariantNumeric: 'tabular-nums' }}>
                    {s.holesCompleted === 0 ? '—' : toPar(s.toPar)}
                  </td>
                  <td style={{ padding: '16px 24px', textAlign: 'right', fontSize: 'clamp(14px, 1.5vw, 20px)', fontVariantNumeric: 'tabular-nums', color: !s.trend || s.trend.direction === 'flat' ? '#6E8A76' : s.trend.direction === 'up' ? '#7FD69A' : '#E58B7B' }}>
                    {!s.trend || s.trend.direction === 'flat' ? '—' : `${s.trend.direction === 'up' ? '↑' : '↓'} ${Math.abs(s.trend.toPar)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* footer: real contest status · real raised total · rotating sponsor */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, marginTop: 22, color: '#8FB89A', fontSize: 'clamp(12px, 1.3vw, 18px)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', flexWrap: 'wrap' }}>
        <span>{contestLine ?? ' '}</span>
        {raisedCents > 0 && <span>Raised Live · <span style={{ color: '#E4B94B' }}>{money(raisedCents)}</span></span>}
        <span style={{ minHeight: 52, display: 'flex', alignItems: 'center', gap: 8 }}>
          {sponsors.length > 0 && <span style={{ fontSize: 'clamp(10px,1vw,13px)', color: '#7FA085' }}>Thanks to</span>}
          {sponsors.length > 0 && <SponsorLogo key={sponsors[sponsorIdx % sponsors.length].company} sponsor={sponsors[sponsorIdx % sponsors.length]} />}
        </span>
      </div>
    </TVShell>
  );
}

// A sponsor's real logo needs to read against the dark-green board without
// destroying it — so we place it (as uploaded, no color-mangling filter) on a
// small light chip. If the image fails to load, fall back to the company name.
function SponsorLogo({ sponsor }: { sponsor: { company: string; logoUrl: string } }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span style={{ color: '#fff', fontWeight: 700, fontSize: 'clamp(13px,1.4vw,18px)' }}>{sponsor.company}</span>;
  return (
    <span style={{ background: '#fff', borderRadius: 8, padding: '5px 10px', display: 'inline-flex', alignItems: 'center' }}>
      <img src={sponsor.logoUrl} alt={sponsor.company} onError={() => setFailed(true)} style={{ maxHeight: 40, maxWidth: 170, objectFit: 'contain', display: 'block' }} />
    </span>
  );
}

function TVShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, #0F3D24 0%, #124A2B 55%, #0C3520 100%)', padding: 'clamp(20px, 3vw, 48px)', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ maxWidth: 1600, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
