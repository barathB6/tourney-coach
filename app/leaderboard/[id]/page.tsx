'use client';

import { useEffect, useState, useCallback, use as usePromise } from 'react';
import { supabase } from '@/lib/supabaseClient';

type Standing = {
  rank: number;
  tied: boolean;
  registrationId: string;
  teamName: string;
  foursomeNumber: number | null;
  holesCompleted: number;
  totalStrokes: number;
  toPar: number | null;
  pace: 'green' | 'yellow' | 'red' | null;
};
type Payload = {
  tournament: { id: string; name: string; format: string; maxScoreRule: string; status: string; parTotal: number | null };
  standings: Standing[];
  teamsTotal: number;
  updatedAt: string;
};

const FORMAT_LABEL: Record<string, string> = {
  scramble: 'Scramble', best_ball: 'Best Ball', alternate_shot: 'Alternate Shot', stroke_play: 'Stroke Play',
};
const toParText = (v: number | null) => (v == null ? '—' : v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
const toParColor = (v: number | null) => (v == null ? '#6B7775' : v < 0 ? '#B91C1C' : v > 0 ? '#1A1F1C' : '#1B6B3A');
const PACE_COLOR: Record<string, string> = { green: '#1B9E4B', yellow: '#E0A32E', red: '#D1495B' };

export default function LeaderboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [flash, setFlash] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tournament/${id}/leaderboard`, { cache: 'no-store' });
      if (!res.ok) { setError(res.status === 404 ? 'Tournament not found.' : 'Could not load the leaderboard.'); return; }
      setData(await res.json());
      setError('');
    } catch {
      setError('Could not load the leaderboard.');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Realtime push on every score write, with a 30s poll as the safety net so
  // the board is never more than half a minute stale even if a push is missed.
  useEffect(() => {
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`leaderboard:${id}`)
      .on('broadcast', { event: 'score' }, () => {
        load();
        if (!reduceMotion) {
          setFlash(true);
          flashTimer = setTimeout(() => setFlash(false), 900);
        }
      })
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    const poll = setInterval(load, 30_000);
    return () => { supabase.removeChannel(channel); clearInterval(poll); clearTimeout(flashTimer); };
  }, [id, load]);

  if (error) return <Shell><p style={{ color: '#B91C1C', textAlign: 'center', fontSize: 15 }}>{error}</p></Shell>;
  if (!data) return <Shell><p style={{ color: '#6B7775', textAlign: 'center' }}>Loading leaderboard…</p></Shell>;

  const { tournament, standings, teamsTotal } = data;
  const anyScores = standings.some((s) => s.holesCompleted > 0);

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 30, fontWeight: 700, color: '#1A1F1C', margin: 0, lineHeight: 1.15 }}>{tournament.name}</h1>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: live ? '#1B6B3A' : '#9AA39D', background: live ? '#E7F4EC' : '#F1ECDD', border: `1px solid ${live ? '#B7E0C6' : '#E5E0D5'}`, borderRadius: 999, padding: '5px 12px', transition: 'background 0.3s', ...(flash ? { background: '#CBEBD5' } : {}) }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: live ? '#1B6B3A' : '#9AA39D' }} />
          {live ? 'Live' : 'Reconnecting…'}
        </span>
      </div>
      <p style={{ fontSize: 13.5, color: '#6B7775', margin: '0 0 20px' }}>
        {FORMAT_LABEL[tournament.format] ?? tournament.format}
        {tournament.parTotal ? ` · Par ${tournament.parTotal}` : ''}
        {` · ${teamsTotal} team${teamsTotal === 1 ? '' : 's'}`}
      </p>

      {!anyScores ? (
        <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: '44px 28px', textAlign: 'center' }}>
          <p style={{ fontSize: 30, margin: '0 0 10px' }}>⛳</p>
          <p style={{ fontFamily: "'Fraunces', serif", fontSize: 19, margin: '0 0 6px', color: '#1A1F1C' }}>No scores in yet</p>
          <p style={{ color: '#6B7775', fontSize: 14, margin: 0 }}>Standings appear here the moment the first team submits a hole.</p>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, overflow: 'hidden' }}>
          <div className="tc-scroll-x" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 460, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E0D5', background: '#FAF8F3' }}>
                  {['Pos', 'Team', 'Thru', 'To Par', 'Total'].map((h, i) => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: i >= 2 ? 'right' : 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {standings.map((s, i) => (
                  <tr key={s.registrationId} style={{ borderBottom: i < standings.length - 1 ? '1px solid #F1ECDD' : 'none', background: s.rank <= 3 && s.holesCompleted > 0 ? '#FCFBF7' : '#fff' }}>
                    <td style={{ padding: '13px 16px', fontWeight: 700, fontSize: 15, color: '#1A1F1C', fontVariantNumeric: 'tabular-nums' }}>
                      {s.holesCompleted === 0 ? '—' : `${s.tied ? 'T' : ''}${s.rank}`}
                    </td>
                    <td style={{ padding: '13px 16px' }}>
                      <div style={{ fontWeight: 600, fontSize: 14.5, color: '#1A1F1C' }}>{s.teamName}</div>
                      {s.foursomeNumber != null && s.teamName !== `Foursome #${s.foursomeNumber}` && <div style={{ fontSize: 11.5, color: '#9AA39D' }}>Foursome #{s.foursomeNumber}</div>}
                    </td>
                    <td style={{ padding: '13px 16px', textAlign: 'right', fontSize: 14, color: '#6B7775', fontVariantNumeric: 'tabular-nums' }}>
                      {s.pace && <span title={`Pace: ${s.pace}`} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: PACE_COLOR[s.pace], marginRight: 6, verticalAlign: 'middle' }} />}
                      {s.holesCompleted === 0 ? '—' : s.holesCompleted === 18 ? 'F' : s.holesCompleted}
                    </td>
                    <td style={{ padding: '13px 16px', textAlign: 'right', fontWeight: 700, fontSize: 15, color: toParColor(s.toPar), fontVariantNumeric: 'tabular-nums' }}>
                      {s.holesCompleted === 0 ? '—' : toParText(s.toPar)}
                    </td>
                    <td style={{ padding: '13px 16px', textAlign: 'right', fontSize: 14, color: '#1A1F1C', fontVariantNumeric: 'tabular-nums' }}>
                      {s.holesCompleted === 0 ? '—' : s.totalStrokes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p style={{ textAlign: 'center', fontSize: 11.5, color: '#9AA39D', marginTop: 16 }}>
        Updates automatically as teams submit scores · Ties broken by USGA scorecard countback
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#F7F5EF', padding: '32px 18px 64px', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
