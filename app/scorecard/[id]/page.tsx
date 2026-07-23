'use client';

import { useEffect, useState, use as usePromise } from 'react';

type Hole = { holeNumber: number; par: number | null; strokes: number | null; toPar: number | null; runningToPar: number | null; contests: string[] };
type Card = {
  team: { name: string; players: string[] };
  tournament: { id: string | null; name: string | null };
  card: Hole[]; holesPlayed: number; totalStrokes: number; toPar: number | null;
};
const CONTEST_ICON: Record<string, string> = { hole_in_one: '⛳', closest_to_pin: '🎯', long_drive: '💥' };
const toParText = (v: number | null) => (v == null ? '' : v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);

export default function ScorecardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<Card | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/registration/${id}/scorecard`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status === 404 ? 'Round not found.' : 'Could not load the scorecard.')))
      .then((d) => { if (active) setData(d); })
      .catch((e) => { if (active) setError(typeof e === 'string' ? e : 'Could not load the scorecard.'); });
    return () => { active = false; };
  }, [id]);

  if (error) return <Shell><p style={{ color: '#B91C1C', textAlign: 'center' }}>{error}</p></Shell>;
  if (!data) return <Shell><p style={{ color: '#6B7775', textAlign: 'center' }}>Loading scorecard…</p></Shell>;

  const front = data.card.filter((h) => h.holeNumber <= 9);
  const back = data.card.filter((h) => h.holeNumber > 9);

  return (
    <Shell>
      <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, color: '#1A1F1C', margin: '0 0 2px' }}>{data.team.name}</h1>
      <p style={{ fontSize: 13.5, color: '#6B7775', margin: '0 0 4px' }}>
        {data.tournament.name}{data.team.players.length ? ` · ${data.team.players.join(', ')}` : ''}
      </p>
      <p style={{ fontSize: 15, color: '#1A1F1C', margin: '0 0 20px', fontWeight: 700 }}>
        {data.holesPlayed === 0 ? 'No holes scored yet' : <>Thru {data.holesPlayed} · {data.totalStrokes} strokes{data.toPar != null && <> · <span style={{ color: data.toPar < 0 ? '#B91C1C' : data.toPar > 0 ? '#1A1F1C' : '#1B6B3A' }}>{toParText(data.toPar)}</span></>}</>}
      </p>

      {[{ label: 'Front 9', holes: front }, { label: 'Back 9', holes: back }].filter((n) => n.holes.length).map((nine) => (
        <div key={nine.label} style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
          <div className="tc-scroll-x" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 460, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#FAF8F3', borderBottom: '1px solid #E5E0D5' }}>
                  <th style={{ ...th, textAlign: 'left' }}>{nine.label}</th>
                  {nine.holes.map((h) => <th key={h.holeNumber} style={th}>{h.holeNumber}{h.contests.map((c) => <span key={c} title={c} style={{ marginLeft: 2 }}>{CONTEST_ICON[c] ?? ''}</span>)}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #F1ECDD' }}>
                  <td style={{ ...td, textAlign: 'left', color: '#6B7775' }}>Par</td>
                  {nine.holes.map((h) => <td key={h.holeNumber} style={{ ...td, color: '#6B7775' }}>{h.par ?? '–'}</td>)}
                </tr>
                <tr>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>Score</td>
                  {nine.holes.map((h) => (
                    <td key={h.holeNumber} style={{ ...td, fontWeight: 700, color: h.strokes == null ? '#C9C2B0' : h.toPar != null && h.toPar < 0 ? '#B91C1C' : '#1A1F1C' }}>
                      {h.strokes ?? '·'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p style={{ textAlign: 'center', fontSize: 11.5, color: '#9AA39D', marginTop: 8 }}>Latest score per hole · corrections already applied</p>
    </Shell>
  );
}

const th: React.CSSProperties = { padding: '9px 10px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#1A1F1C', fontVariantNumeric: 'tabular-nums' };
const td: React.CSSProperties = { padding: '9px 10px', textAlign: 'center', fontSize: 14, fontVariantNumeric: 'tabular-nums' };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#F7F5EF', padding: '32px 18px 64px', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
