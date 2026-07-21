'use client';

// Public rendering preview for the GPS hole map. This is a DESIGN PREVIEW with
// clearly-labelled SAMPLE geometry — not a real course, no live data. It exists
// so the aggregated-map UI (and its confidence/verified badges) can be seen at
// a URL before any course has accumulated live multi-tournament GPS. Real maps
// render on the player Live Round view (/live/[registrationId]).
import HoleSchematic, { type SchematicHole } from '@/components/gps/HoleSchematic';

const TEE = { lat: 36.56820, lng: -121.94970 };
const GREEN = { lat: 36.56690, lng: -121.94830 };
const M_LAT = 111_320;
const M_LNG = M_LAT * Math.cos((36.568 * Math.PI) / 180);

// a gentle dogleg-right fairway: interpolate tee→green, bulge perpendicular
const fairwayWaypoints = Array.from({ length: 8 }, (_, i) => {
  const f = (i + 1) / 9;
  const baseLat = TEE.lat + (GREEN.lat - TEE.lat) * f;
  const baseLng = TEE.lng + (GREEN.lng - TEE.lng) * f;
  const bulgeM = Math.sin(f * Math.PI) * 22; // up to 22m right of the line
  const ax = (GREEN.lng - TEE.lng) * M_LNG, ay = (GREEN.lat - TEE.lat) * M_LAT;
  const len = Math.hypot(ax, ay);
  const px = ay / len, py = -ax / len; // perpendicular unit (meters)
  return { lat: baseLat + (py * bulgeM) / M_LAT, lng: baseLng + (px * bulgeM) / M_LNG };
});

const VERIFIED: SchematicHole = {
  holeNumber: 4,
  par: 4,
  description: 'Dogleg right; bunker guards the inside of the turn.',
  teeYardages: { black: 415, blue: 392, white: 360, red: 305 },
  gpsStatus: {
    tee: { lat: TEE.lat, lng: TEE.lng, confidence: 0.83, tournaments: 7 },
    green: { lat: GREEN.lat, lng: GREEN.lng, confidence: 0.78, tournaments: 6 },
    fairway: { waypoints: fairwayWaypoints, confidence: 0.71, tournaments: 6 },
  },
  hazards: [{ lat: 36.567585, lng: -121.948995, confidence: 0.87 }],
};

// Same hole earlier in its life: only 2 tournaments in, nothing verified yet.
const BUILDING: SchematicHole = {
  holeNumber: 4,
  par: 4,
  description: 'Early data — positions found, but not yet corroborated.',
  teeYardages: { black: 415, blue: 392, white: 360, red: 305 },
  gpsStatus: {
    tee: { lat: TEE.lat, lng: TEE.lng, confidence: 0.51, tournaments: 2 },
    green: { lat: GREEN.lat, lng: GREEN.lng, confidence: 0.44, tournaments: 2 },
    fairway: { waypoints: fairwayWaypoints, confidence: 0.51, tournaments: 2 },
  },
  hazards: [],
};

const NO_DATA: SchematicHole = {
  holeNumber: 11,
  par: 3,
  description: 'No live rounds recorded here yet.',
  teeYardages: { black: 180, white: 155, red: 120 },
  gpsStatus: null,
  hazards: [],
};

const CARDS: { caption: string; hole: SchematicHole }[] = [
  { caption: 'Verified — aggregated across many tournaments (green ✓ badges)', hole: VERIFIED },
  { caption: 'Building confidence — only 2 tournaments in (muted badges)', hole: BUILDING },
  { caption: 'No GPS yet — honest yardage fallback', hole: NO_DATA },
];

export default function HoleMapPreview() {
  return (
    <div style={{ minHeight: '100vh', background: '#F7F5EF', padding: '28px 20px 64px', fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <p style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, color: '#1A1F1C', margin: '0 0 6px' }}>Hole map — rendering preview</p>
        <p style={{ color: '#6B7775', fontSize: 14, margin: '0 0 14px', maxWidth: 640 }}>
          How a hole draws as GPS data accumulates from live play. Real maps appear on the player Live Round view (<code>/live/&lt;registration-id&gt;</code>).
        </p>
        <p style={{ background: '#FFF3D6', border: '1px solid #E6CE86', borderRadius: 8, padding: '9px 13px', color: '#7A5A08', fontSize: 13, display: 'inline-block', margin: '0 0 24px' }}>
          ⚠ SAMPLE DATA — illustrative geometry, not a real course. No live numbers.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 22, alignItems: 'start' }}>
          {CARDS.map((c) => (
            <div key={c.caption}>
              <p style={{ fontSize: 13, color: '#4A544F', margin: '0 0 8px', minHeight: 34 }}>{c.caption}</p>
              <HoleSchematic hole={c.hole} maxWidth={320} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
