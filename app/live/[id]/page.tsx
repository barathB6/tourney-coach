'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import HoleSchematic, { type SchematicHole, type GpsHazard } from '@/components/gps/HoleSchematic';
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
// Battery/quality gates (Day 20): a golfer is stationary for most of a round,
// and a phone walking out of a clubhouse emits garbage cold-start fixes. Both
// gates yield to a keep-alive so bad signal degrades to sparse points, never
// to silence — the queue keeps breathing even at ±80m accuracy.
const MAX_ACCURACY_M = 50;   // drop fixes worse than this…
const MIN_MOVE_M = 4;        // …and near-duplicates while standing still…
const KEEPALIVE_MS = 60000;  // …unless we'd otherwise log nothing for a minute

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
  const [markingTee, setMarkingTee] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [teeResult, setTeeResult] = useState('');
  // Inferred hazards live in course_gps_features, not course_holes.gps_status,
  // so they come from the aggregated course profile endpoint (best-effort).
  const [hazardsByHole, setHazardsByHole] = useState<Record<number, GpsHazard[]>>({});

  const queueRef = useRef<QueuedPoint[]>([]);
  const lastLoggedAtRef = useRef(0);
  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    async function load() {
      const existingToken = localStorage.getItem(deviceKey(regId));
      const res = await fetch(`/api/gps/context/${regId}${existingToken ? `?device=${existingToken}` : ''}`);
      if (!res.ok) { setNotFound(true); setLoading(false); return; }
      const data: Context = await res.json();
      setCtx(data);
      setCurrentHole(data.registration.startingHole ?? 1);
      // Best-effort: pull aggregated hazards for this course (non-blocking; the
      // map renders fine without them).
      if (data.tournament?.courseId) {
        fetch(`/api/course/${data.tournament.courseId}/profile`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p) => {
            if (!p?.holes) return;
            const map: Record<number, GpsHazard[]> = {};
            for (const h of p.holes) {
              if (Array.isArray(h.gpsDerived?.hazards) && h.gpsDerived.hazards.length) map[h.holeNumber] = h.gpsDerived.hazards;
            }
            setHazardsByHole(map);
          })
          .catch(() => { /* profile is optional */ });
      }
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

    // Start "one interval ago", NOT at 0: otherwise the first fix reads as
    // overdue and bypasses the accuracy gate — and the first fix after
    // opening the page is exactly the cold-start garbage the gate rejects.
    lastLoggedAtRef.current = Date.now() - LOG_EVERY_MS;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGeoError('');
        // watchPosition fires as often as the OS likes; only keep a point
        // every LOG_EVERY_MS per the spec's 15-second logging interval.
        const sinceLast = pos.timestamp - lastLoggedAtRef.current;
        if (sinceLast < LOG_EVERY_MS) return;
        const overdue = sinceLast >= KEEPALIVE_MS;
        // Quality gate: garbage-accuracy fixes pollute green labeling and
        // waste upload battery — but never go fully silent (see KEEPALIVE_MS).
        if ((pos.coords.accuracy ?? 0) > MAX_ACCURACY_M && !overdue) return;
        // Stationary dedup: standing on a tee shouldn't stack identical points.
        const prev = lastPosRef.current;
        if (prev && !overdue) {
          const movedM = Math.hypot(
            (pos.coords.latitude - prev.lat) * 111_320,
            (pos.coords.longitude - prev.lng) * 111_320 * Math.cos((prev.lat * Math.PI) / 180),
          );
          if (movedM < MIN_MOVE_M) return;
        }
        lastLoggedAtRef.current = pos.timestamp;
        lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
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
      // Friendly pick-up-at-par message: explain the cap, don't silently rewrite.
      const capPart = data.capped ? ` Max score reached — recorded as ${data.strokesRecorded} (pick-up rule).` : '';
      if (data.capped) setStrokes(data.strokesRecorded);
      // Don't claim the score was saved when the server said it wasn't.
      setScoreResult(data.scoreStored ? `Score saved —${capPart} ${labelPart}.` : `Score NOT stored (database not ready) — ${labelPart}.`);
    } catch (err) {
      setScoreResult(err instanceof Error ? err.message : 'Score submission failed');
    } finally {
      setSubmittingScore(false);
    }
  }

  // Manual tee-box mark: take a FRESH high-accuracy fix (not the throttled
  // watch cache) at the moment the player taps, since "here" should be the
  // spot they're standing on right now, and tag it as this hole's tee.
  async function markTee() {
    setMarkingTee(true);
    setTeeResult('');
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
      );
      const res = await fetch('/api/gps/mark-tee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken, holeNumber: currentHole, lat: pos.coords.latitude, lng: pos.coords.longitude }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not mark tee');
      setTeeResult(`Tee box for hole ${currentHole} marked at your position.`);
    } catch (err) {
      const msg = err instanceof GeolocationPositionError || (err && typeof err === 'object' && 'code' in err)
        ? 'Could not read your location — check permission and try again.'
        : err instanceof Error ? err.message : 'Could not mark tee';
      setTeeResult(msg);
    } finally {
      setMarkingTee(false);
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
    ? { holeNumber: hole.hole_number, par: hole.par, description: hole.description, teeYardages: hole.tee_yardages, gpsStatus: hole.gps_status, hazards: hazardsByHole[hole.hole_number] }
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

            <button
              onClick={markTee}
              disabled={markingTee}
              style={{ width: '100%', marginTop: 12, padding: '11px', background: '#fff', color: '#1B4425', border: '1.5px solid #1B4425', borderRadius: 10, fontWeight: 700, fontSize: 13.5, cursor: markingTee ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: markingTee ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 22V4l14 4-14 4" /></svg>
              {markingTee ? 'Reading location…' : 'Mark tee box here'}
            </button>
            {teeResult && <p style={{ fontSize: 12.5, color: teeResult.startsWith('Tee box') ? '#1B6B3A' : '#B91C1C', margin: '8px 0 0' }} data-testid="tee-result">{teeResult}</p>}
          </div>
        )}

        {schematicHole ? (
          <>
            <HoleSchematic hole={schematicHole} />
            <button
              onClick={() => setMapOpen(true)}
              style={{ width: '100%', marginTop: 10, padding: '11px', background: '#fff', color: '#1B4425', border: '1px solid #E5E0D5', borderRadius: 10, fontWeight: 700, fontSize: 13.5, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2z" /><path d="M9 3v16M15 5v16" /></svg>
              View full map
            </button>
          </>
        ) : (
          <p style={{ textAlign: 'center', color: '#6B7775', fontSize: 13 }}>No data for this hole yet.</p>
        )}
      </div>

      <a
        href={`/leaderboard/${ctx.tournament.id}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', maxWidth: 460, margin: '14px auto 0', padding: '13px', background: '#1B4425', color: '#fff', border: 'none', borderRadius: 12, fontWeight: 700, fontSize: 14.5, textDecoration: 'none', boxSizing: 'border-box', fontFamily: "'DM Sans', sans-serif" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16M7 20V10M12 20V4M17 20v-7" /></svg>
        Live leaderboard
      </a>

      {mapOpen && schematicHole && (
        <div
          onClick={() => setMapOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(26,31,28,.55)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, maxHeight: '92vh', overflowY: 'auto', position: 'relative' }}>
            <button
              onClick={() => setMapOpen(false)}
              aria-label="Close map"
              style={{ position: 'absolute', top: 12, right: 12, zIndex: 1, width: 34, height: 34, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 17, lineHeight: 1, color: '#1A1F1C' }}
            >
              ✕
            </button>
            <HoleSchematic hole={schematicHole} maxWidth={360} />
          </div>
        </div>
      )}
    </div>
  );
}
