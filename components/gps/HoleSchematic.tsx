'use client';

import { TEES, TEE_LABELS, type Tee } from '@/lib/course';

const TEE_COLORS: Record<Tee, string> = {
  black: '#1A1F1C',
  blue: '#2563AA',
  white: '#E5E0D5',
  gold: '#C9A227',
  red: '#B91C1C',
};

// ── Real GPS-derived shapes (from the Day 19 aggregation, served by
//    /api/course/[id]/profile and mirrored into course_holes.gps_status) ──────
export interface GpsPoint { lat: number; lng: number; confidence?: number | null; tournaments?: number | null }
export interface GpsFairway { waypoints: { lat: number; lng: number }[]; confidence?: number | null; tournaments?: number | null }
export interface GpsHazard { lat: number; lng: number; confidence?: number | null }

export interface SchematicHole {
  holeNumber: number;
  par: number | null;
  description: string | null;
  shapeTags?: string[] | null;
  teeYardages: Partial<Record<Tee, number>>;
  gpsStatus?: { tee?: unknown; fairway?: unknown; green?: unknown } | null;
  hazards?: GpsHazard[] | null;
}

const WIDTH = 260;
const HEIGHT = 500;
const TOP = 50; // green sits near the top of the card
const BOTTOM = 460;

const VERIFIED_THRESHOLD = 0.7; // must match lib/gps/aggregateCore.ts
const M_PER_DEG_LAT = 111_320;

const asPoint = (v: unknown): GpsPoint | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o.lat === 'number' && typeof o.lng === 'number'
    ? { lat: o.lat, lng: o.lng, confidence: typeof o.confidence === 'number' ? o.confidence : null, tournaments: typeof o.tournaments === 'number' ? o.tournaments : null }
    : null;
};
const asFairway = (v: unknown): GpsFairway | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.waypoints)) return null;
  const waypoints = o.waypoints.filter((w): w is { lat: number; lng: number } => !!w && typeof (w as Record<string, unknown>).lat === 'number' && typeof (w as Record<string, unknown>).lng === 'number');
  return waypoints.length >= 2 ? { waypoints, confidence: typeof o.confidence === 'number' ? o.confidence : null, tournaments: typeof o.tournaments === 'number' ? o.tournaments : null } : null;
};

// A projected, TO-SCALE top-down map: latitude/longitude are converted to local
// meters (longitude compressed by cos(lat)), then rotated so the tee→green axis
// points up — the classic hole-strip view — and fitted to the card with a
// single scale so distances read true. Falls back to the yardage schematic when
// no real GPS aggregation exists yet.
export default function HoleSchematic({ hole, highlightTee, maxWidth = 220 }: { hole: SchematicHole; highlightTee?: Tee | null; maxWidth?: number }) {
  const entries = TEES
    .map((tee) => ({ tee, yards: hole.teeYardages[tee] }))
    .filter((e): e is { tee: Tee; yards: number } => typeof e.yards === 'number');

  const tee = asPoint(hole.gpsStatus?.tee);
  const green = asPoint(hole.gpsStatus?.green);
  const fairway = asFairway(hole.gpsStatus?.fairway);
  const hazards = (hole.hazards ?? []).filter((h) => typeof h?.lat === 'number' && typeof h?.lng === 'number');
  // A real map needs both ends anchored; anything less stays schematic.
  const realMap = tee && green ? buildMap(tee, green, fairway, hazards) : null;

  return (
    <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <p style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 700, margin: 0, color: '#1A1F1C' }}>Hole {hole.holeNumber}</p>
        <p style={{ fontSize: 13, color: '#6B7775', margin: 0 }}>{hole.par ? `Par ${hole.par}` : ''}</p>
      </div>
      {hole.description && <p style={{ fontSize: 12.5, color: '#6B7775', margin: '0 0 10px' }}>{hole.description}</p>}

      {realMap ? (
        <RealMap map={realMap} tee={tee!} green={green!} fairway={fairway} maxWidth={maxWidth} />
      ) : (
        <SchematicSvg entries={entries} highlightTee={highlightTee} maxWidth={maxWidth} shapeTags={hole.shapeTags ?? []} />
      )}

      {realMap ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, justifyContent: 'center' }}>
          <ConfidenceBadge label="Tee" confidence={tee!.confidence} tournaments={tee!.tournaments} color="#1A1F1C" />
          <ConfidenceBadge label="Green" confidence={green!.confidence} tournaments={green!.tournaments} color="#1B6B3A" />
          {fairway && <ConfidenceBadge label="Fairway" confidence={fairway.confidence} tournaments={fairway.tournaments} color="#2563AA" />}
          {hazards.length > 0 && <ConfidenceBadge label={hazards.length > 1 ? `${hazards.length} hazards` : 'Hazard'} confidence={Math.max(...hazards.map((h) => h.confidence ?? 0))} color="#B45309" />}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, justifyContent: 'center' }}>
          {entries.map(({ tee: t }) => (
            <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B7775' }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: TEE_COLORS[t], display: 'inline-block' }} />
              {TEE_LABELS[t]}
            </span>
          ))}
        </div>
      )}

      {!realMap && entries.length === 0 && (
        <p style={{ textAlign: 'center', color: '#6B7775', fontSize: 12.5, marginTop: 12 }}>No tee yardages set for this hole yet.</p>
      )}

      <p style={{ textAlign: 'center', fontSize: 10.5, color: '#9AA39D', marginTop: 10, marginBottom: 0 }}>
        {realMap
          ? 'To scale · mapped from live tournament play'
          : `Schematic layout, not to scale · GPS data not yet collected`}
      </p>
    </div>
  );
}

// ── Projection ──────────────────────────────────────────────────────────────
interface ScreenPt { x: number; y: number }
interface BuiltMap {
  teeXY: ScreenPt;
  greenXY: ScreenPt;
  fairwayXY: ScreenPt[];
  hazardsXY: { pt: ScreenPt; confidence: number | null }[];
  greenRadius: number;
  hazardRadius: number;
}

function buildMap(tee: GpsPoint, green: GpsPoint, fairway: GpsFairway | null, hazards: GpsHazard[]): BuiltMap | null {
  const kx = Math.cos((tee.lat * Math.PI) / 180) * M_PER_DEG_LAT;
  // metric coords relative to the tee (east = +x, north = +y)
  const toM = (p: { lat: number; lng: number }) => ({ x: (p.lng - tee.lng) * kx, y: (p.lat - tee.lat) * M_PER_DEG_LAT });
  const gM = toM(green);
  const axisLen = Math.hypot(gM.x, gM.y);
  if (!(axisLen > 0)) return null;
  // unit vector tee→green (u) and its perpendicular (v)
  const ux = gM.x / axisLen, uy = gM.y / axisLen;
  const vx = uy, vy = -ux;
  // rotate into (perp, along) space: along = distance up the hole, perp = sideways
  const rot = (p: { x: number; y: number }) => ({ perp: p.x * vx + p.y * vy, along: p.x * ux + p.y * uy });

  const teeR = rot({ x: 0, y: 0 });
  const greenR = rot(gM);
  const fairR = (fairway?.waypoints ?? []).map((w) => rot(toM(w)));
  const hazR = hazards.map((h) => ({ r: rot(toM(h)), confidence: h.confidence ?? null }));

  const alongs = [teeR.along, greenR.along, ...fairR.map((p) => p.along), ...hazR.map((p) => p.r.along)];
  const perps = [teeR.perp, greenR.perp, ...fairR.map((p) => p.perp), ...hazR.map((p) => p.r.perp)];
  const padM = Math.max(12, axisLen * 0.08); // breathing room around the extremes
  const alongMin = Math.min(...alongs) - padM, alongMax = Math.max(...alongs) + padM;
  const perpMin = Math.min(...perps) - padM, perpMax = Math.max(...perps) + padM;

  const usableW = WIDTH - 24, usableH = BOTTOM - TOP;
  const scale = Math.min(usableW / Math.max(perpMax - perpMin, 1), usableH / Math.max(alongMax - alongMin, 1));
  const perpMid = (perpMin + perpMax) / 2;
  // higher "along" (toward the green) sits higher on the card → smaller y
  const project = (p: { perp: number; along: number }): ScreenPt => ({
    x: WIDTH / 2 + (p.perp - perpMid) * scale,
    y: TOP + (alongMax - p.along) * scale,
  });

  return {
    teeXY: project(teeR),
    greenXY: project(greenR),
    fairwayXY: fairR.map(project),
    hazardsXY: hazR.map((h) => ({ pt: project(h.r), confidence: h.confidence })),
    greenRadius: Math.max(9, 9 * scale),   // ~9m green footprint, min 9px
    hazardRadius: Math.max(8, 12 * scale), // ~12m hazard footprint, min 8px
  };
}

function RealMap({ map, fairway, maxWidth }: { map: BuiltMap; tee: GpsPoint; green: GpsPoint; fairway: GpsFairway | null; maxWidth: number }) {
  // Fairway corridor drawn as a fat translucent band through tee → waypoints → green.
  const corridor = [map.teeXY, ...map.fairwayXY, map.greenXY];
  const path = corridor.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: '100%', maxWidth, display: 'block', margin: '0 auto' }}>
      <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="#F4F8F5" rx={10} />
      {/* fairway corridor */}
      <path d={path} fill="none" stroke="#C8DDD1" strokeWidth={26} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
      {fairway && <path d={path} fill="none" stroke="#8FBF9F" strokeWidth={2.5} strokeDasharray="5 5" strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />}

      {/* hazards */}
      {map.hazardsXY.map((h, i) => (
        <g key={`hz${i}`}>
          <circle cx={h.pt.x} cy={h.pt.y} r={map.hazardRadius} fill="#F2D08A" stroke="#B45309" strokeWidth={1.5} />
          <text x={h.pt.x} y={h.pt.y + 3.5} fontSize={10} textAnchor="middle" fill="#7A4A08" fontFamily="'DM Sans', sans-serif">⚠</text>
        </g>
      ))}

      {/* green */}
      <ellipse cx={map.greenXY.x} cy={map.greenXY.y} rx={map.greenRadius + 3} ry={map.greenRadius} fill="#8FBF9F" stroke="#1B6B3A" strokeWidth={1.5} />
      <line x1={map.greenXY.x} y1={map.greenXY.y - map.greenRadius - 16} x2={map.greenXY.x} y2={map.greenXY.y} stroke="#1A1F1C" strokeWidth={1.5} />
      <polygon points={`${map.greenXY.x},${map.greenXY.y - map.greenRadius - 16} ${map.greenXY.x + 11},${map.greenXY.y - map.greenRadius - 11} ${map.greenXY.x},${map.greenXY.y - map.greenRadius - 6}`} fill="#B91C1C" />

      {/* tee */}
      <rect x={map.teeXY.x - 7} y={map.teeXY.y - 7} width={14} height={14} rx={3} fill="#1A1F1C" />
      <text x={map.teeXY.x} y={map.teeXY.y + 26} fontSize={10.5} textAnchor="middle" fill="#6B7775" fontFamily="'DM Sans', sans-serif">TEE</text>
    </svg>
  );
}

// ── Illustrative fallback shapes ─────────────────────────────────────────
// Drawn from the pro's shape/feature tags — never from real GPS data (that's
// RealMap's job). Purely a stylized guide until the course has real
// aggregated tee/green points.
interface CenterPt { t: number; x: number; y: number }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function buildCenterline(shapeTags: string[]): CenterPt[] {
  const teeX = WIDTH / 2, teeY = BOTTOM - 6;
  const greenX = WIDTH / 2, greenY = TOP + 4;
  const BEND = 52;
  const pts: CenterPt[] = [{ t: 0, x: teeX, y: teeY }];
  if (shapeTags.includes('double_dogleg')) {
    pts.push({ t: 0.35, x: teeX - BEND, y: lerp(teeY, greenY, 0.35) });
    pts.push({ t: 0.65, x: teeX + BEND, y: lerp(teeY, greenY, 0.65) });
  } else if (shapeTags.includes('dogleg_left')) {
    pts.push({ t: 0.5, x: teeX - BEND, y: lerp(teeY, greenY, 0.5) });
  } else if (shapeTags.includes('dogleg_right')) {
    pts.push({ t: 0.5, x: teeX + BEND, y: lerp(teeY, greenY, 0.5) });
  }
  pts.push({ t: 1, x: greenX, y: greenY });
  return pts;
}

function pointOnCenterline(pts: CenterPt[], t: number): { x: number; y: number } {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      const local = (t - a.t) / (b.t - a.t || 1);
      return { x: lerp(a.x, b.x, local), y: lerp(a.y, b.y, local) };
    }
  }
  return pts[pts.length - 1];
}

const pathD = (pts: CenterPt[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

function SchematicSvg({ entries, highlightTee, maxWidth, shapeTags }: { entries: { tee: Tee; yards: number }[]; highlightTee?: Tee | null; maxWidth: number; shapeTags: string[] }) {
  const maxYards = entries.length ? Math.max(...entries.map((e) => e.yards)) : 0;
  const centerline = buildCenterline(shapeTags);
  const greenPt = centerline[centerline.length - 1];
  const teePt = centerline[0];
  const elevated = shapeTags.includes('elevated_green');

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: '100%', maxWidth, display: 'block', margin: '0 auto' }}>
      {/* fairway corridor, bent per dogleg tags */}
      <path d={pathD(centerline)} fill="none" stroke="#EAF2ED" strokeWidth={64} strokeLinecap="round" strokeLinejoin="round" />
      <path d={pathD(centerline)} fill="none" stroke="#C8DDD1" strokeWidth={2} strokeDasharray="5 6" strokeLinejoin="round" opacity={0.8} />

      {shapeTags.includes('waste_areas') && (() => {
        const p = pointOnCenterline(centerline, 0.42);
        return <ellipse cx={p.x - 40} cy={p.y} rx={30} ry={16} fill="#E8D7A8" stroke="#B8A05A" strokeWidth={1} opacity={0.85} />;
      })()}
      {shapeTags.includes('fairway_bunkers') && (() => {
        const p = pointOnCenterline(centerline, 0.55);
        return (
          <>
            <ellipse cx={p.x - 40} cy={p.y} rx={15} ry={9} fill="#F2E1B0" stroke="#B8A05A" strokeWidth={1} />
            <ellipse cx={p.x + 40} cy={p.y} rx={15} ry={9} fill="#F2E1B0" stroke="#B8A05A" strokeWidth={1} />
          </>
        );
      })()}
      {shapeTags.includes('pot_bunkers') && (() => {
        const p = pointOnCenterline(centerline, 0.62);
        return (
          <>
            <circle cx={p.x - 22} cy={p.y} r={7} fill="#F2E1B0" stroke="#8A7433" strokeWidth={1} />
            <circle cx={p.x + 22} cy={p.y - 10} r={7} fill="#F2E1B0" stroke="#8A7433" strokeWidth={1} />
          </>
        );
      })()}
      {shapeTags.includes('blind_shot') && (() => {
        const p = pointOnCenterline(centerline, 0.32);
        return (
          <g>
            <path d={`M${p.x - 46},${p.y + 10} Q${p.x},${p.y - 22} ${p.x + 46},${p.y + 10} Z`} fill="#DDE3D6" stroke="#AEB8A5" strokeWidth={1} />
            <text x={p.x} y={p.y + 2} fontSize={11} textAnchor="middle" fill="#6B7775" fontFamily="'DM Sans', sans-serif">rise</text>
          </g>
        );
      })()}

      {/* green */}
      {elevated && <ellipse cx={greenPt.x} cy={greenPt.y + 4} rx={34} ry={24} fill="none" stroke="#B7CFC0" strokeWidth={1.5} />}
      <ellipse cx={greenPt.x} cy={greenPt.y} rx={26} ry={18} fill="#8FBF9F" stroke="#1B6B3A" strokeWidth={1.5} />
      {elevated && <text x={greenPt.x} y={greenPt.y - 26} fontSize={11} textAnchor="middle" fill="#6B7775" fontFamily="'DM Sans', sans-serif">▲ elevated</text>}
      <line x1={greenPt.x} y1={greenPt.y - 18} x2={greenPt.x} y2={greenPt.y + 4} stroke="#1A1F1C" strokeWidth={1.5} />
      <polygon points={`${greenPt.x},${greenPt.y - 18} ${greenPt.x + 12},${greenPt.y - 13} ${greenPt.x},${greenPt.y - 8}`} fill="#B91C1C" />

      {/* tee */}
      <rect x={teePt.x - 7} y={teePt.y - 7} width={14} height={14} rx={3} fill="#1A1F1C" />

      {entries.map(({ tee, yards }) => {
        const t = maxYards > 0 ? yards / maxYards : 0;
        const p = pointOnCenterline(centerline, Math.min(1, Math.max(0, t)));
        const active = highlightTee === tee;
        return (
          <g key={tee}>
            <rect x={p.x - 7} y={p.y - 7} width={14} height={14} fill={TEE_COLORS[tee]} stroke={active ? '#1B4425' : 'none'} strokeWidth={active ? 3 : 0} rx={3} />
            <text x={p.x + 16} y={p.y + 4} fontSize={11} fill="#1A1F1C" fontFamily="'DM Sans', sans-serif">{yards}y</text>
          </g>
        );
      })}
    </svg>
  );
}

function ConfidenceBadge({ label, confidence, tournaments, color }: { label: string; confidence?: number | null; tournaments?: number | null; color: string }) {
  const c = typeof confidence === 'number' ? confidence : null;
  const verified = c != null && c >= VERIFIED_THRESHOLD;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
        padding: '3px 9px', borderRadius: 999,
        background: verified ? '#E7F4EC' : '#F3F4F2',
        color: verified ? '#1B6B3A' : '#6B7775',
        border: `1px solid ${verified ? '#B7E0C6' : '#E5E0D5'}`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
      {c != null && (
        <span style={{ fontWeight: 700 }}>
          {verified ? '✓ ' : ''}{Math.round(c * 100)}%
        </span>
      )}
      {typeof tournaments === 'number' && tournaments > 0 && (
        <span style={{ fontWeight: 400, opacity: 0.75 }}>· {tournaments} {tournaments === 1 ? 'event' : 'events'}</span>
      )}
    </span>
  );
}
