'use client';

import { TEES, TEE_LABELS, type Tee } from '@/lib/course';

const TEE_COLORS: Record<Tee, string> = {
  black: '#1A1F1C',
  blue: '#2563AA',
  white: '#E5E0D5',
  gold: '#C9A227',
  red: '#B91C1C',
};

export interface SchematicHole {
  holeNumber: number;
  par: number | null;
  description: string | null;
  teeYardages: Partial<Record<Tee, number>>;
  gpsStatus?: { tee?: unknown; fairway?: unknown; green?: unknown } | null;
}

const WIDTH = 260;
const TOP = 50; // green sits near the top of the card
const BOTTOM = 460;

// A schematic top-down diagram built entirely from course_holes yardage/tee
// data — no satellite imagery, no mapping API key. Tee markers are placed
// proportionally along a single fairway axis by yardage; there's no real
// dogleg/terrain geometry to draw since none of that is captured yet.
export default function HoleSchematic({ hole, highlightTee, maxWidth = 220 }: { hole: SchematicHole; highlightTee?: Tee | null; maxWidth?: number }) {
  const entries = TEES
    .map((tee) => ({ tee, yards: hole.teeYardages[tee] }))
    .filter((e): e is { tee: Tee; yards: number } => typeof e.yards === 'number');

  const maxYards = entries.length ? Math.max(...entries.map((e) => e.yards)) : 0;
  const yFor = (yards: number) => (maxYards > 0 ? TOP + (yards / maxYards) * (BOTTOM - TOP) : BOTTOM);

  const hasRealGps = !!(hole.gpsStatus?.tee || hole.gpsStatus?.green);

  return (
    <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <p style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 700, margin: 0, color: '#1A1F1C' }}>Hole {hole.holeNumber}</p>
        <p style={{ fontSize: 13, color: '#6B7775', margin: 0 }}>{hole.par ? `Par ${hole.par}` : ''}</p>
      </div>
      {hole.description && <p style={{ fontSize: 12.5, color: '#6B7775', margin: '0 0 10px' }}>{hole.description}</p>}

      <svg viewBox={`0 0 ${WIDTH} 500`} style={{ width: '100%', maxWidth, display: 'block', margin: '0 auto' }}>
        <polygon
          points={`${WIDTH / 2 - 10},${TOP + 20} ${WIDTH / 2 + 10},${TOP + 20} ${WIDTH / 2 + 46},${BOTTOM} ${WIDTH / 2 - 46},${BOTTOM}`}
          fill="#EAF2ED"
          stroke="#C8DDD1"
          strokeWidth={1}
        />
        <ellipse cx={WIDTH / 2} cy={TOP} rx={26} ry={18} fill="#8FBF9F" stroke="#1B6B3A" strokeWidth={1.5} />
        <line x1={WIDTH / 2} y1={TOP - 18} x2={WIDTH / 2} y2={TOP + 4} stroke="#1A1F1C" strokeWidth={1.5} />
        <polygon points={`${WIDTH / 2},${TOP - 18} ${WIDTH / 2 + 12},${TOP - 13} ${WIDTH / 2},${TOP - 8}`} fill="#B91C1C" />

        {entries.map(({ tee, yards }) => {
          const y = yFor(yards);
          const active = highlightTee === tee;
          return (
            <g key={tee}>
              <rect
                x={WIDTH / 2 - 7}
                y={y - 7}
                width={14}
                height={14}
                fill={TEE_COLORS[tee]}
                stroke={active ? '#1B4425' : 'none'}
                strokeWidth={active ? 3 : 0}
                rx={3}
              />
              <text x={WIDTH / 2 + 16} y={y + 4} fontSize={11} fill="#1A1F1C" fontFamily="'DM Sans', sans-serif">{yards}y</text>
            </g>
          );
        })}
      </svg>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, justifyContent: 'center' }}>
        {entries.map(({ tee }) => (
          <span key={tee} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B7775' }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: TEE_COLORS[tee], display: 'inline-block' }} />
            {TEE_LABELS[tee]}
          </span>
        ))}
      </div>

      {entries.length === 0 && (
        <p style={{ textAlign: 'center', color: '#6B7775', fontSize: 12.5, marginTop: 12 }}>No tee yardages set for this hole yet.</p>
      )}

      <p style={{ textAlign: 'center', fontSize: 10.5, color: '#9AA39D', marginTop: 10, marginBottom: 0 }}>
        Schematic layout, not to scale · {hasRealGps ? 'GPS-mapped from live play' : 'GPS data not yet collected'}
      </p>
    </div>
  );
}
