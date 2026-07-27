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
const scoreQueueKey = (regId: string) => `tc_score_queue_${regId}`;

// A score entered while offline. It carries the time it was ENTERED (enteredAt)
// so that when it finally syncs, latest-wins ordering on the leaderboard still
// reflects when the team actually played the hole — not when the phone
// reconnected.
type QueuedScore = { holeNumber: number; strokes: number; enteredAt: string };

// Score tiers relative to par (spec Module 6). Strokes = par + offset; the
// event's max-score rule caps anything past its cutoff server-side.
const SCORE_TIERS: [string, number][] = [['Eagle', -2], ['Birdie', -1], ['Par', 0], ['Bogey', 1], ['+2', 2], ['+3', 3]];

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
  // Contest holes (HIO / closest-to-pin / long-drive) shown as scorecard badges.
  const [contestsByHole, setContestsByHole] = useState<Record<number, string[]>>({});

  const queueRef = useRef<QueuedPoint[]>([]);
  const lastLoggedAtRef = useRef(0);
  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const flushRef = useRef<() => void>(() => {});
  // Offline score queue: scores entered without a connection, synced later.
  const scoreQueueRef = useRef<QueuedScore[]>([]);
  const [pendingScores, setPendingScores] = useState(0);
  // Module 7 — TourneyCircle opt-in, fired after the final hole is submitted.
  const [circlePrompt, setCirclePrompt] = useState(false);
  const [circleRadius, setCircleRadius] = useState(25);
  const [circleResult, setCircleResult] = useState('');
  const [circleBusy, setCircleBusy] = useState(false);
  const flushScoresRef = useRef<() => void>(() => {});

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
      // Contest holes are tournament-level (not gated on a course), best-effort.
      if (data.tournament?.id) {
        fetch(`/api/tournament/${data.tournament.id}/board`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((b) => {
            if (!Array.isArray(b?.contests)) return;
            const map: Record<number, string[]> = {};
            for (const c of b.contests) { if (c.holeNumber != null) (map[c.holeNumber] ??= []).push(c.type); }
            setContestsByHole(map);
          })
          .catch(() => { /* contests are optional */ });
      }
      if (existingToken) {
        setDeviceToken(existingToken);
        setConsent(data.hasConsent ? 'granted' : 'declined');
        const savedQueue = localStorage.getItem(queueKey(regId));
        if (savedQueue) {
          try { queueRef.current = JSON.parse(savedQueue); } catch { /* corrupt cache, drop it */ }
        }
      }
      // Restore any scores that were entered offline in a previous session so
      // they sync as soon as we're back online.
      const savedScores = localStorage.getItem(scoreQueueKey(regId));
      if (savedScores) {
        try { scoreQueueRef.current = JSON.parse(savedScores); setPendingScores(scoreQueueRef.current.length); } catch { /* corrupt, drop */ }
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

  // Persist + push one score. Throws on network/HTTP failure so the caller can
  // queue it. enteredAt (when the player actually entered it) is honored by the
  // server as submitted_at so offline scores keep correct latest-wins ordering.
  const postScore = useCallback(async (deviceToken: string, holeNumber: number, strokes: number, enteredAt: string, fix?: { lat: number; lng: number; accuracy: number | null } | null) => {
    const res = await fetch('/api/gps/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceToken, holeNumber, strokes, enteredAt,
        ...(fix ? { currentLat: fix.lat, currentLng: fix.lng, currentAccuracy: fix.accuracy } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Score submission failed');
    return data as { scoreStored: boolean; capped?: boolean; strokesRecorded?: number; labeledPoints: number };
  }, []);

  // The patent's mandatory step: a FRESH high-accuracy fix taken at the instant
  // of submission — the player is standing on the green — attached to the score
  // so it's labeled as this hole's green even if the throttled watch buffer is
  // stale. Never throws: a denied/failed fix yields null and the score still
  // posts (GPS may legitimately be null).
  const currentFix = useCallback(async (): Promise<{ lat: number; lng: number; accuracy: number | null } | null> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }),
      );
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
    } catch {
      return null;
    }
  }, []);

  // Drain the offline score queue — called on reconnect, on a timer, and on
  // load. Stops at the first still-failing score so order is preserved.
  const flushScores = useCallback(async () => {
    if (!deviceToken || !scoreQueueRef.current.length || !navigator.onLine) return;
    const pending = [...scoreQueueRef.current];
    for (const q of pending) {
      try {
        await postScore(deviceToken, q.holeNumber, q.strokes, q.enteredAt);
        scoreQueueRef.current = scoreQueueRef.current.filter((s) => s !== q);
        localStorage.setItem(scoreQueueKey(regId), JSON.stringify(scoreQueueRef.current));
        setPendingScores(scoreQueueRef.current.length);
      } catch {
        break; // still offline / server down — try again next trigger
      }
    }
  }, [deviceToken, postScore, regId]);
  useEffect(() => { flushScoresRef.current = flushScores; }, [flushScores]);

  // Sync queued scores the moment the connection returns, plus a slow retry
  // timer and an attempt as soon as the device token is ready.
  useEffect(() => {
    if (!deviceToken) return;
    flushScoresRef.current();
    const onOnline = () => { flushRef.current(); flushScoresRef.current(); };
    window.addEventListener('online', onOnline);
    const retry = setInterval(() => flushScoresRef.current(), 20000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(retry); };
  }, [deviceToken]);

  // The patent trigger, from the player's side: flush buffered GPS first so
  // the contemporaneous points are server-side, then submit the score — the
  // server labels those points as this hole's green location. If the network
  // is down, the score is queued and synced on reconnect (never lost).
  async function submitScore() {
    if (!deviceToken) return;
    setSubmittingScore(true);
    setScoreResult('');
    const enteredAt = new Date().toISOString();
    const holeAtEntry = currentHole;
    try {
      // Flush buffered points and grab a fresh contemporaneous fix in parallel;
      // both feed the green-labeling for this hole.
      const [, fix] = await Promise.all([flush(), currentFix()]);
      const data = await postScore(deviceToken, holeAtEntry, strokes, enteredAt, fix);
      const labelPart = data.labeledPoints > 0
        ? `green location for hole ${holeAtEntry} labeled from ${data.labeledPoints} GPS point${data.labeledPoints === 1 ? '' : 's'}`
        : 'no recent GPS points were available to label';
      // Friendly pick-up-at-par message: explain the cap, don't silently rewrite.
      const capPart = data.capped ? ` Max score reached — recorded as ${data.strokesRecorded} (pick-up rule).` : '';
      if (data.capped && data.strokesRecorded) setStrokes(data.strokesRecorded);
      // Don't claim the score was saved when the server said it wasn't.
      setScoreResult(data.scoreStored ? `Score saved —${capPart} ${labelPart}.` : `Score NOT stored (database not ready) — ${labelPart}.`);
      // The inventive timing (Patent Concept B): ask at the peak-engagement
      // moment — right after the final hole is in.
      if (holeAtEntry === 18 && data.scoreStored) setCirclePrompt(true);
    } catch (err) {
      // Offline or the request failed — queue the score so it's not lost, and
      // sync it automatically when the connection comes back.
      if (!navigator.onLine || err instanceof TypeError) {
        scoreQueueRef.current = [...scoreQueueRef.current.filter((s) => s.holeNumber !== holeAtEntry), { holeNumber: holeAtEntry, strokes, enteredAt }];
        localStorage.setItem(scoreQueueKey(regId), JSON.stringify(scoreQueueRef.current));
        setPendingScores(scoreQueueRef.current.length);
        setScoreResult(`No signal — hole ${holeAtEntry} saved on your phone. It'll sync automatically when you're back online.`);
      } else {
        setScoreResult(err instanceof Error ? err.message : 'Score submission failed');
      }
    } finally {
      setSubmittingScore(false);
    }
  }

  // TourneyCircle opt-in / decline. Takes a one-time location fix (if allowed)
  // so the player can be matched to nearby tournaments; the organizer never
  // sees it — only aggregate counts. A decline is recorded so we never re-ask.
  async function circleOptIn(decline: boolean) {
    setCircleBusy(true); setCircleResult('');
    let homeLat: number | null = null, homeLng: number | null = null;
    if (!decline && typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 60000 }));
        homeLat = pos.coords.latitude; homeLng = pos.coords.longitude;
      } catch { /* no location — opt-in still recorded, just not matchable yet */ }
    }
    try {
      const res = await fetch('/api/circle/opt-in', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationId: regId, decline, radiusMiles: circleRadius, homeLat, homeLng }),
      });
      const d = await res.json().catch(() => ({}));
      if (decline) { setCirclePrompt(false); return; }
      setCircleResult(res.ok
        ? `You're in.${d.memberCountNearby ? ` ${d.memberCountNearby} TourneyCircle golfer${d.memberCountNearby === 1 ? '' : 's'} near you.` : ''}`
        : (d.error || 'Could not save — try again.'));
    } catch {
      setCircleResult('Could not save — check your connection.');
    } finally {
      setCircleBusy(false);
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
          <button aria-label="Previous hole" onClick={() => changeHole(currentHole <= 1 ? ctx.course!.totalHoles : currentHole - 1)} style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 20, flexShrink: 0, touchAction: 'manipulation' }}>‹</button>
          <p style={{ fontWeight: 700, fontSize: 15, margin: 0, minWidth: 96, textAlign: 'center' }}>Hole {currentHole} of {ctx.course.totalHoles}</p>
          <button aria-label="Next hole" onClick={() => changeHole(currentHole >= ctx.course!.totalHoles ? 1 : currentHole + 1)} style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 20, flexShrink: 0, touchAction: 'manipulation' }}>›</button>
        </div>

        {(contestsByHole[currentHole] ?? []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            {contestsByHole[currentHole].map((c) => (
              <span key={c} style={{ fontSize: 12, fontWeight: 700, color: '#7A4A08', background: '#FFF3D6', border: '1px solid #E6CE86', borderRadius: 999, padding: '4px 11px' }}>
                {{ hole_in_one: '⛳ Hole-in-One', closest_to_pin: '🎯 Closest to Pin', long_drive: '💥 Long Drive' }[c] ?? '🏆 Contest'}
              </span>
            ))}
          </div>
        )}

        {consent === 'granted' && (
          <div style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
            <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 10px' }}>Score for hole {currentHole}{hole?.par ? ` · Par ${hole.par}` : ''}</p>
            {hole?.par != null ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {SCORE_TIERS.map(([label, off]) => {
                    const val = Math.max(1, (hole.par as number) + off);
                    const active = strokes === val;
                    return (
                      <button key={label} onClick={() => setStrokes(val)} style={{ padding: '10px 6px', borderRadius: 10, border: active ? '1.5px solid #1B4425' : '1px solid #E5E0D5', background: active ? '#EAF2ED' : '#fff', cursor: 'pointer', touchAction: 'manipulation', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: active ? '#1B4425' : '#1A1F1C' }}>{label}</span>
                        <span style={{ fontSize: 11.5, color: '#6B7775', fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                      </button>
                    );
                  })}
                </div>
                <p style={{ fontSize: 11.5, color: '#6B7775', margin: '8px 0 0' }}>Par is your friend — pick up at your cap and keep pace; anything past it records as the cap.</p>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button aria-label="Lower score" onClick={() => setStrokes((n) => Math.max(1, n - 1))} style={{ width: 48, height: 48, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 22, flexShrink: 0, touchAction: 'manipulation' }}>−</button>
                <p style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, margin: 0, minWidth: 36, textAlign: 'center' }}>{strokes}</p>
                <button aria-label="Raise score" onClick={() => setStrokes((n) => Math.min(20, n + 1))} style={{ width: 48, height: 48, borderRadius: '50%', border: '1px solid #E5E0D5', background: '#fff', cursor: 'pointer', fontSize: 22, flexShrink: 0, touchAction: 'manipulation' }}>+</button>
              </div>
            )}
            <button
              onClick={submitScore}
              disabled={submittingScore}
              style={{ width: '100%', marginTop: 12, padding: '12px', background: '#1B4425', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: submittingScore ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: submittingScore ? 0.7 : 1 }}
            >
              {submittingScore ? 'Submitting…' : `Submit${hole?.par != null ? ` ${strokes}` : ''}`}
            </button>
            {scoreResult && <p style={{ fontSize: 12.5, color: scoreResult.startsWith('Score saved') ? '#1B6B3A' : scoreResult.startsWith('No signal') ? '#B08900' : '#B91C1C', margin: '10px 0 0' }} data-testid="score-result">{scoreResult}</p>}
            {pendingScores > 0 && (
              <p style={{ fontSize: 11.5, color: '#B08900', background: '#FFF7E0', border: '1px solid #F0E2B8', borderRadius: 8, padding: '6px 10px', margin: '8px 0 0' }} data-testid="pending-scores">
                ⏳ {pendingScores} score{pendingScores === 1 ? '' : 's'} saved offline — syncing automatically when you have signal.
              </p>
            )}

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
        href={`/tv/${ctx.tournament.id}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', maxWidth: 460, margin: '14px auto 0', padding: '13px', background: '#1B4425', color: '#fff', border: 'none', borderRadius: 12, fontWeight: 700, fontSize: 14.5, textDecoration: 'none', boxSizing: 'border-box', fontFamily: "'DM Sans', sans-serif" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
        TV Leaderboard
      </a>

      <a
        href={`/scorecard/${regId}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', maxWidth: 460, margin: '10px auto 0', padding: '11px', background: '#fff', color: '#1B4425', border: '1px solid #E5E0D5', borderRadius: 12, fontWeight: 700, fontSize: 13.5, textDecoration: 'none', boxSizing: 'border-box', fontFamily: "'DM Sans', sans-serif" }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
        Your scorecard
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

      {circlePrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,74,38,0.97)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22, zIndex: 100 }}>
          <div style={{ maxWidth: 380, width: '100%', textAlign: 'center', color: '#fff', fontFamily: "'DM Sans', sans-serif" }}>
            {!circleResult ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#C9A227', marginBottom: 16 }}>TourneyCircle</div>
                <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 25, lineHeight: 1.2, margin: '0 0 12px' }}>Nice round! Want to hear about other charity golf tournaments near you?</h2>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.75)', margin: '0 0 22px', lineHeight: 1.5 }}>Only in your area. Your info never leaves TourneyCoach — organizers never see your name or email.</p>
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginBottom: 8 }}>Within</div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    {[15, 25, 35, 50].map((r) => (
                      <button key={r} onClick={() => setCircleRadius(r)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)', background: circleRadius === r ? '#C9A227' : 'transparent', color: circleRadius === r ? '#2E1F04' : '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>{r} mi</button>
                    ))}
                  </div>
                </div>
                <button onClick={() => circleOptIn(false)} disabled={circleBusy} style={{ width: '100%', padding: '14px', background: '#C9A227', color: '#2E1F04', border: 'none', borderRadius: 12, fontWeight: 700, fontSize: 15, cursor: 'pointer', marginBottom: 10, fontFamily: 'inherit' }}>{circleBusy ? 'Saving…' : 'Yes, keep me posted'}</button>
                <button onClick={() => circleOptIn(true)} disabled={circleBusy} style={{ width: '100%', padding: '12px', background: 'transparent', color: 'rgba(255,255,255,0.7)', border: 'none', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>No thanks</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 44, marginBottom: 12 }}>⛳</div>
                <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 25, margin: '0 0 10px' }}>{circleResult}</h2>
                <a href={`/circle/preferences?reg=${regId}`} style={{ display: 'block', color: 'rgba(255,255,255,0.8)', fontSize: 13.5, marginTop: 8 }}>Choose your causes & how often →</a>
                <button onClick={() => setCirclePrompt(false)} style={{ marginTop: 16, padding: '12px 26px', background: '#fff', color: '#0F4A26', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>Done</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
