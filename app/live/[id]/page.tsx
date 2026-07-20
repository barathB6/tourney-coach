'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import HoleSchematic, { type SchematicHole } from '@/components/gps/HoleSchematic';
import type { Tee } from '@/lib/course';

type Hole = {
  hole_number: number;
  par: number | null;
  description: string | null;
  tee_yardages: Partial<Record<Tee, number>>;
  gps_status: { tee?: unknown; fairway?: unknown; green?: unknown } | null;
};

type Context = {
  registration: { id: string; contactName: string; startingHole: number | null };
  tournament: { id: string; name: string; courseId: string; selectedTees: string[] | null };
  course: { id: string; name: string; totalHoles: number; tees: string[] } | null;
  holes: Hole[];
  hasConsent: boolean | null;
};

type QueuedPoint = { lat: number; lng: number; accuracy?: number; recordedAt: string };

// Module 8 collection contract: GPS track logging every 15 seconds via
// navigator.geolocation.watchPosition(), buffered locally and transmitted
// in batches — not continuously (battery consideration). With no score
// submission to piggyback on yet, batches flush on hole change, on the page
// going hidden, and on a slow fallback timer so a phone dying mid-round
// loses at most a couple minutes of cached points.
const LOG_EVERY_MS = 15000;
const FALLBACK_FLUSH_MS = 120000;
const MAX_QUEUE_BEFORE_FLUSH = 40;

const deviceKey = (regId: string) => `tc_gps_device_${regId}`;
const queueKey = (regId: string) => `tc_gps_queue_${regId}`;

export default function LiveRoundPage() {
  const params = useParams();
  const regId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [currentHole, setCurrentHole] = useState(1);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [consent, setConsent] = useState<'unknown' | 'granted' | 'declined'>('unknown');
  const [pingCount, setPingCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [geoError, setGeoError] = useState('');
  const [starting, setStarting] = useState(false);
  const [strokes, setStrokes] = useState(4);
  const [submittingScore, setSubmittingScore] = useState(false);
  const [scoreResult, setScoreResult] = useState('');

  const queueRef = useRef<QueuedPoint[]>([]);
  const lastLoggedAtRef = useRef(0);
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    async function load() {
      const existingToken = localStorage.getItem(deviceKey(regId));
      const res = await fetch(`/api/gps/context/${regId}${existingToken ? `?device=${existingToken}` : ''}`);
      if (!res.ok) { setNotFound(true); setLoading(false); return; }
      const data: Context = await res.json();
      setCtx(data);
      setCurrentHole(data.registration.startingHole ?? 1);
      if (existingToken) {
        setDeviceToken(existingToken);
        setConsent(data.hasConsent ? 'granted' : 'declined');
        const savedQueue = localStorage.getItem(queueKey(regId));
        if (savedQueue) {
          try { queueRef.current = JSON.parse(savedQueue); } catch { /* corrupt cache, drop it */ }
        }
      }
      setLoading(false);
    }
    load();
  }, [regId]);

  const persistQueue = useCallback(() => {
    localStorage.setItem(queueKey(regId), JSON.stringify(queueRef.current));
  }, [regId]);

  const flush = useCallback(async () => {
    if (!queueRef.current.length || !deviceToken || !ctx?.tournament || !navigator.onLine) return;
    const batch = queueRef.current;
    queueRef.current = [];
    persistQueue();
    try {
      const res = await fetch('/api/gps/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keepalive lets a flush triggered by the page going hidden survive
        // the navigation instead of being cancelled mid-request.
        keepalive: true,
        body: JSON.stringify({
          deviceToken,
          tournamentId: ctx.tournament.id,
          courseId: ctx.tournament.courseId,
          holeNumber: currentHole,
          points: batch,
        }),
      });
      if (!res.ok) throw new Error('flush failed');
      setPingCount((c) => c + batch.length);
      setLastSyncedAt(new Date().toISOString());
    } catch {
      // Connectivity gap, not data loss — put the batch back at the front of the queue.
      queueRef.current = [...batch, ...queueRef.current];
      persistQueue();
    }
  }, [deviceToken, ctx, currentHole, persistQueue]);

  // The effect below intentionally only re-runs on consent changes; it
  // reaches the latest flush (which closes over the current hole) via a ref.
  useEffect(() => { flushRef.current = flush; }, [flush]);

  useEffect(() => {
    if (consent !== 'granted') return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoError('');
        // watchPosition fires as often as the OS likes; only keep a point
        // every LOG_EVERY_MS per the spec's 15-second logging interval.
        if (pos.timestamp - lastLoggedAtRef.current < LOG_EVERY_MS) return;
        lastLoggedAtRef.current = pos.timestamp;
        queueRef.current.push({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          recordedAt: new Date(pos.timestamp).toISOString(),
        });
        persistQueue();
        if (queueRef.current.length >= MAX_QUEUE_BEFORE_FLUSH) flushRef.current();
      },
      (err) => setGeoError(err.message || 'Location unavailable'),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );

    const fallbackTimer = setInterval(() => flushRef.current(), FALLBACK_FLUSH_MS);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushRef.current(); };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearInterval(fallbackTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent]);

  // Flush under the hole the points were actually collected on BEFORE
  // switching — flush() closes over the outgoing hole number.
  function changeHole(next: number) {
    flushRef.current();
    setCurrentHole(next);
    setScoreResult('');
  }

  // The patent trigger, from the player's side: flush buffered GPS first so
  // the contemporaneous points are server-side, then submit the score — the
  // server labels those points as this hole's green location.
  async function submitScore() {
    if (!deviceToken) return;
    setSubmittingScore(true);
    setScoreResult('');
    try {
      await flush();
      const res = await fetch('/api/gps/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken, holeNumber: currentHole, strokes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Score submission failed');
      const labelPart = data.labeledPoints > 0
        ? `green location for hole ${currentHole} labeled from ${data.labeledPoints} GPS point${data.labeledPoints === 1 ? '' : 's'}`
        : 'no recent GPS points were available to label';
      // Don't claim the score was saved when the server said it wasn't.
      setScoreResult(data.scoreStored ? `Score saved — ${labelPart}.` : `Score NOT stored (database not ready) — ${labelPart}.`);
    } catch (err) {
      setScoreResult(err instanceof Error ? err.message : 'Score submission failed');
    } finally {
      setSubmittingScore(false);
    }
  }

  async function grantConsent() {
    setStarting(true);
    try {
      const token = deviceToken ?? crypto.randomUUID();
      const res = await fetch('/api/gps/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationId: regId, deviceToken: token, playerName: ctx?.registration.contactName ?? null }),
      });
      if (!res.ok) throw new Error('Failed to start tracking — try again');
      localStorage.setItem(deviceKey(regId), token);
      setDeviceToken(token);
      setConsent('granted');
      setGeoError('');
    } catch {
      setGeoError('Could not start tracking — try again in a moment.');
    } finally {
      setStarting(false);
    }
  }

  async function revokeConsent() {
    // Drop anything still cached locally — revoking consent means nothing
    // else leaves this phone, including points collected moments ago.
    queueRef.current = [];
    persistQueue();
    if (deviceToken) {
      await fetch('/api/gps/consent/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken }),
      });
    }
    setConsent('declined');
  }

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '24px 16px', color: '#1A1F1C' },
    wrap: { maxWidth: 420, margin: '0 auto' },
  };

  if (loading) return <div style={s.page}><p style={{ color: '#6B7775' }}>Loading…</p></div>;

  if (notFound || !ctx || !ctx.course) {
    return (
      <div style={s.page}>
        <div style={s.wrap}>
          <p style={{ fontSize: 32, marginBottom: 8 }}>⛳</p>
          <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 6 }}>Round link not found</p>
          <p style={{ color: '#6B7775', fontSize: 13.5 }}>This link doesn&rsquo;t match an active registration, or the course hasn&rsquo;t been set up yet.</p>
        </div>
      </div>
    );
  }

  const hole = ctx.holes.find((h) => h.hole_number === currentHole);
  const schematicHole: SchematicHole | null = hole
    ? { holeNumber: hole.hole_number, par: hole.par, description: hole.description, teeYardages: hole.tee_yardages, gpsStatus: hole.gps_status }
    : null;

  return (
    <div style={s.page}>
      <div style={s.wrap}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 4px' }}>{ctx.tournament.name}</p>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: '0 0 16px' }}>{ctx.course.name}</h1>

        {consent === 'unknown' && (
          <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 20, marginBottom: 20 }}>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 17, fontWeight: 700, margin: '0 0 10px' }}>Helps map this course for future events</p>
            <p style={{ fontSize: 13.5, color: '#3D453F', lineHeight: 1.6, margin: '0 0 8px' }}>
              With your permission, your phone logs its location every 15 seconds while you play — nothing else. That&rsquo;s how tee, fairway, and green locations get mapped automatically, with no manual surveying. Your browser will also ask for location permission; both are required.
            </p>
            <ul style={{ fontSize: 13, color: '#6B7775', margin: '0 0 14px', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Completely optional — the course map below works either way</li>
              <li>Only used to improve course maps, never sold</li>
              <li>Turn it off anytime from this page</li>
            </ul>
            {geoError && <p style={{ color: '#B91C1C', fontSize: 12.5, marginBottom: 10 }}>{geoError}</p>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={grantConsent}
                disabled={starting}
                style={{ flex: 1, padding: '12px', background: '#1B4425', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: starting ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: starting ? 0.7 : 1 }}
              >
                {starting ? 'Starting…' : 'I Agree — Start Tracking'}
              </button>
              <button
                onClick={() => setConsent('declined')}
                style={{ padding: '12px 16px', background: 'transparent', color: '#6B7775', border: '1px solid #E5E0D5', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
              >
                No Thanks
              </button>
            </div>
          </div>
        )}

        {consent === 'granted' && (
          <div style={{ background: '#EAF2ED', border: '1px solid #C8DDD1', borderRadius: 12, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ fontWeight: 700, color: '#1B6B3A', fontSize: 13.5, margin: 0 }}>● GPS tracking active</p>
              <p style={{ fontSize: 11.5, color: '#5C6B62', margin: '2px 0 0' }}>
                {pingCount} points synced{lastSyncedAt ? ` · last synced ${new Date(lastSyncedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
              </p>
            </div>
            <button onClick={revokeConsent} style={{ fontSize: 11.5, color: '#6B7775', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}>Turn off</button>
          </div>
        )}

        {consent === 'declined' && (
          <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 12, padding: '10px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ fontSize: 12.5, color: '#6B7775', margin: 0 }}>GPS tracking is off</p>
            <button onClick={() => setConsent('unknown')} style={{ fontSize: 11.5, color: '#1B4425', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}>Turn on</button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 14 }}>
          <button onClick={() => changeHole(currentHole <= 1 ? ctx.course!.totalHoles : currentHole - 1)} style={{ width: 34, height: 34, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 16 }}>‹</button>
          <p style={{ fontWeight: 700, fontSize: 14, margin: 0, minWidth: 90, textAlign: 'center' }}>Hole {currentHole} of {ctx.course.totalHoles}</p>
          <button onClick={() => changeHole(currentHole >= ctx.course!.totalHoles ? 1 : currentHole + 1)} style={{ width: 34, height: 34, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 16 }}>›</button>
        </div>

        {consent === 'granted' && (
          <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
            <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 10px' }}>Score for hole {currentHole}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={() => setStrokes((n) => Math.max(1, n - 1))} style={{ width: 34, height: 34, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 16 }}>−</button>
              <p style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: 0, minWidth: 28, textAlign: 'center' }}>{strokes}</p>
              <button onClick={() => setStrokes((n) => Math.min(20, n + 1))} style={{ width: 34, height: 34, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 16 }}>+</button>
              <button
                onClick={submitScore}
                disabled={submittingScore}
                style={{ flex: 1, padding: '11px', background: '#1B4425', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13.5, cursor: submittingScore ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: submittingScore ? 0.7 : 1 }}
              >
                {submittingScore ? 'Submitting…' : 'Submit score'}
              </button>
            </div>
            {scoreResult && <p style={{ fontSize: 12.5, color: scoreResult.startsWith('Score saved') ? '#1B6B3A' : '#B91C1C', margin: '10px 0 0' }} data-testid="score-result">{scoreResult}</p>}
          </div>
        )}

        {schematicHole ? <HoleSchematic hole={schematicHole} /> : (
          <p style={{ textAlign: 'center', color: '#6B7775', fontSize: 13 }}>No data for this hole yet.</p>
        )}
      </div>
    </div>
  );
}
