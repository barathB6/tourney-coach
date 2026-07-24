// GPS collection engine for the Live Round screen — the mobile half of the
// Day 18 pipeline, hitting the same production API routes as the web
// /live/[id] page (consent audit log, batch ingestion, score-triggered
// green labeling). Module 8 contract: log a fix every 15 seconds while the
// round screen is active, cache locally through connectivity gaps, and
// transmit in batches — on hole change, on backgrounding, on a slow
// fallback timer — never continuously (battery).
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { config } from './config';

export type QueuedPoint = { lat: number; lng: number; accuracy?: number; recordedAt: string };

const LOG_EVERY_MS = 15000;
export const FALLBACK_FLUSH_MS = 120000;
const MAX_QUEUE_BEFORE_FLUSH = 40;
// Battery/quality gates (Day 20). These are JS-level only — deliberately NOT
// an OS distance filter: a distance filter suppresses callbacks entirely
// while stationary, and standing still at a tee or green is precisely when
// the two patent mechanisms need points (first-ping tee clustering, ±3min
// green labeling). With callbacks flowing every 15s, the gates cut logged
// points ~4x while stationary (one per KEEPALIVE_MS) without ever going
// silent. Both gates yield to KEEPALIVE_MS so bad signal degrades to sparse
// points, never silence.
const MAX_ACCURACY_M = 50;
const MIN_MOVE_M = 4;
const KEEPALIVE_MS = 60000;

const deviceKey = (regId: string) => `tc_gps_device_${regId}`;
const queueKey = (regId: string) => `tc_gps_queue_${regId}`;
const scoreQueueKey = (regId: string) => `tc_score_queue_${regId}`;

// A score entered while offline. enteredAt (when the player actually entered
// it) is honored by the server as submitted_at so a late sync keeps correct
// latest-wins ordering — matching the web client.
export type QueuedScore = { holeNumber: number; strokes: number; enteredAt: string };

export async function loadScoreQueue(registrationId: string): Promise<QueuedScore[]> {
  try {
    const raw = await AsyncStorage.getItem(scoreQueueKey(registrationId));
    return raw ? (JSON.parse(raw) as QueuedScore[]) : [];
  } catch {
    return [];
  }
}
export function persistScoreQueue(registrationId: string, queue: QueuedScore[]) {
  AsyncStorage.setItem(scoreQueueKey(registrationId), JSON.stringify(queue)).catch(() => {});
}

export async function getOrCreateDeviceToken(registrationId: string): Promise<string> {
  const existing = await AsyncStorage.getItem(deviceKey(registrationId));
  if (existing) return existing;
  const token = Crypto.randomUUID();
  await AsyncStorage.setItem(deviceKey(registrationId), token);
  return token;
}

export async function loadQueue(registrationId: string): Promise<QueuedPoint[]> {
  try {
    const raw = await AsyncStorage.getItem(queueKey(registrationId));
    return raw ? (JSON.parse(raw) as QueuedPoint[]) : [];
  } catch {
    return []; // corrupt cache — drop it
  }
}

export function persistQueue(registrationId: string, queue: QueuedPoint[]) {
  AsyncStorage.setItem(queueKey(registrationId), JSON.stringify(queue)).catch(() => {});
}

async function api(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

export type LiveContext = {
  registration: { id: string; contactName: string; startingHole: number | null };
  tournament: { id: string; name: string; courseId: string };
  course: { id: string; name: string; totalHoles: number } | null;
  holes: { hole_number: number; par: number | null }[];
  hasConsent: boolean | null;
};

export async function getContext(registrationId: string, deviceToken?: string | null): Promise<LiveContext | null> {
  const qs = deviceToken ? `?device=${deviceToken}` : '';
  const res = await fetch(`${config.apiBaseUrl}/api/gps/context/${registrationId}${qs}`);
  if (!res.ok) return null;
  return (await res.json()) as LiveContext;
}

export const grantConsent = (registrationId: string, deviceToken: string, playerName: string | null) =>
  api('/api/gps/consent', { registrationId, deviceToken, playerName });

export const revokeConsent = (deviceToken: string) => api('/api/gps/consent/revoke', { deviceToken });

export const uploadBatch = (params: {
  deviceToken: string; tournamentId: string; courseId: string; holeNumber: number; points: QueuedPoint[];
}) => api('/api/gps/track', params);

export const submitScore = (params: { deviceToken: string; holeNumber: number; strokes: number; enteredAt?: string }) =>
  api('/api/gps/score', params);

export const markTee = (params: { deviceToken: string; holeNumber: number; lat: number; lng: number }) =>
  api('/api/gps/mark-tee', params);

// A fresh high-accuracy single fix for "mark tee here" — the player's spot
// at tap time, not the throttled watch cache.
export async function getCurrentFix(): Promise<{ lat: number; lng: number } | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}

// Foreground OS permission + a throttled watcher. Returns a stop function.
// The OS permission dialog this triggers carries the consent language from
// app.json's expo-location plugin config.
export async function startWatching(onPoint: (p: QueuedPoint) => void): Promise<{ stop: () => void } | { error: string }> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') {
    return { error: 'Location permission was declined — tracking stays off.' };
  }
  // Start "one interval ago", NOT at 0: with lastLoggedAt=0 the first fix
  // would read as overdue and bypass the accuracy gate — and the first fix
  // after opening the app is exactly the cold-start/WiFi-centroid garbage
  // the gate exists to reject (and exactly the ping tee clustering keys on).
  let lastLoggedAt = Date.now() - LOG_EVERY_MS;
  let lastPos: { lat: number; lng: number } | null = null;
  const sub = await Location.watchPositionAsync(
    // timeInterval is respected on Android; iOS delivers on its own cadence,
    // so the manual throttle below is what actually enforces the 15s rule.
    // distanceInterval stays 0 — see the gate comment above: an OS distance
    // filter would starve the keep-alive while the player stands still.
    { accuracy: Location.Accuracy.High, timeInterval: LOG_EVERY_MS, distanceInterval: 0 },
    (pos) => {
      const sinceLast = pos.timestamp - lastLoggedAt;
      if (sinceLast < LOG_EVERY_MS) return;
      const overdue = sinceLast >= KEEPALIVE_MS;
      if ((pos.coords.accuracy ?? 0) > MAX_ACCURACY_M && !overdue) return;
      if (lastPos && !overdue) {
        const movedM = Math.hypot(
          (pos.coords.latitude - lastPos.lat) * 111_320,
          (pos.coords.longitude - lastPos.lng) * 111_320 * Math.cos((lastPos.lat * Math.PI) / 180),
        );
        if (movedM < MIN_MOVE_M) return;
      }
      lastLoggedAt = pos.timestamp;
      lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      onPoint({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? undefined,
        recordedAt: new Date(pos.timestamp).toISOString(),
      });
    }
  );
  return { stop: () => sub.remove() };
}

export const QUEUE_FLUSH_THRESHOLD = MAX_QUEUE_BEFORE_FLUSH;
