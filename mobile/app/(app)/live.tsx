import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { colors, font } from '../../lib/theme';
import {
  type QueuedPoint, type LiveContext,
  getOrCreateDeviceToken, loadQueue, persistQueue, getContext,
  grantConsent, revokeConsent, uploadBatch, submitScore as submitScoreApi,
  markTee as markTeeApi, getCurrentFix,
  startWatching, FALLBACK_FLUSH_MS, QUEUE_FLUSH_THRESHOLD,
} from '../../lib/liveRound';

type Registration = { id: string; contact_name: string; registration_type: string };

// Live Round — the mobile home of the Day 18 GPS pipeline. Same
// non-negotiable consent flow as the web /live page, then passive 15s
// collection with offline caching and batch upload, and the patent trigger:
// submitting a score labels the contemporaneous GPS points as that hole's
// green. All against the production API.
export default function LiveRoundScreen() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [regs, setRegs] = useState<Registration[]>([]);
  const [tournamentName, setTournamentName] = useState('');
  const [ctx, setCtx] = useState<LiveContext | null>(null);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [consent, setConsent] = useState<'unknown' | 'granted' | 'declined'>('unknown');
  const [currentHole, setCurrentHole] = useState(1);
  const [pingCount, setPingCount] = useState(0);
  const [strokes, setStrokes] = useState(4);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [scoreResult, setScoreResult] = useState('');
  const [teeResult, setTeeResult] = useState('');
  const [markingTee, setMarkingTee] = useState(false);

  const queueRef = useRef<QueuedPoint[]>([]);
  const stopWatchRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  // Organizer picks which registration (foursome) this phone tracks for.
  useEffect(() => {
    (async () => {
      const uid = session?.user.id;
      if (!uid) return;
      const { data: t } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('organizer_id', uid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (t) {
        setTournamentName(t.name);
        const { data: r } = await supabase
          .from('registrations')
          .select('id, contact_name, registration_type')
          .eq('tournament_id', t.id)
          .order('created_at', { ascending: false });
        setRegs(r ?? []);
      }
      setLoading(false);
    })();
  }, [session]);

  const flush = useCallback(async () => {
    const regId = ctx?.registration.id;
    if (!regId || !deviceToken || !ctx?.tournament || queueRef.current.length === 0) return;
    const batch = queueRef.current;
    queueRef.current = [];
    persistQueue(regId, queueRef.current);
    const res = await uploadBatch({
      deviceToken,
      tournamentId: ctx.tournament.id,
      courseId: ctx.tournament.courseId,
      holeNumber: currentHole,
      points: batch,
    }).catch(() => ({ ok: false as const, status: 0, data: {} }));
    if (res.ok) {
      setPingCount((c) => c + batch.length);
    } else {
      // Connectivity gap, not data loss — batch goes back to the front.
      queueRef.current = [...batch, ...queueRef.current];
      persistQueue(regId, queueRef.current);
    }
  }, [ctx, deviceToken, currentHole]);
  useEffect(() => { flushRef.current = flush; }, [flush]);

  async function pickRegistration(reg: Registration) {
    setBusy(true);
    setNotice('');
    try {
      const token = await getOrCreateDeviceToken(reg.id);
      setDeviceToken(token);
      queueRef.current = await loadQueue(reg.id);
      const context = await getContext(reg.id, token);
      if (!context || !context.course) {
        setNotice('This tournament has no course profile yet — GPS mapping needs one.');
        return;
      }
      setCtx(context);
      setCurrentHole(context.registration.startingHole ?? 1);
      setConsent(context.hasConsent ? 'granted' : 'unknown');
    } finally {
      setBusy(false);
    }
  }

  async function agree() {
    if (!ctx || !deviceToken) return;
    setBusy(true);
    setNotice('');
    try {
      const res = await grantConsent(ctx.registration.id, deviceToken, ctx.registration.contactName ?? null);
      if (!res.ok) throw new Error('Could not record consent — try again.');
      setConsent('granted');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not record consent.');
    } finally {
      setBusy(false);
    }
  }

  // Collection lifecycle: only while consented and this screen is mounted.
  useEffect(() => {
    if (consent !== 'granted' || !ctx || !deviceToken) return;
    let cancelled = false;
    (async () => {
      const result = await startWatching((p) => {
        if (cancelled) return;
        queueRef.current.push(p);
        persistQueue(ctx.registration.id, queueRef.current);
        if (queueRef.current.length >= QUEUE_FLUSH_THRESHOLD) flushRef.current();
      });
      if ('error' in result) {
        setNotice(result.error);
        setConsent('declined');
        return;
      }
      if (cancelled) { result.stop(); return; }
      stopWatchRef.current = result.stop;
    })();

    const timer = setInterval(() => flushRef.current(), FALLBACK_FLUSH_MS);
    const appState = AppState.addEventListener('change', (s) => {
      if (s !== 'active') flushRef.current();
    });
    return () => {
      cancelled = true;
      stopWatchRef.current?.();
      stopWatchRef.current = null;
      clearInterval(timer);
      appState.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent, ctx?.registration.id, deviceToken]);

  function changeHole(next: number) {
    flushRef.current(); // attribute buffered points to the outgoing hole
    setCurrentHole(next);
    setScoreResult('');
    setTeeResult('');
  }

  // Manual tee mark: fresh fix at tap time -> tag as this hole's tee.
  async function onMarkTee() {
    if (!deviceToken) return;
    setMarkingTee(true);
    setTeeResult('');
    try {
      const fix = await getCurrentFix();
      if (!fix) { setTeeResult('Could not read your location — check permission and try again.'); return; }
      const res = await markTeeApi({ deviceToken, holeNumber: currentHole, lat: fix.lat, lng: fix.lng });
      if (!res.ok) throw new Error((res.data.error as string) || 'Could not mark tee');
      setTeeResult(`Tee box for hole ${currentHole} marked at your position.`);
    } catch (e) {
      setTeeResult(e instanceof Error ? e.message : 'Could not mark tee');
    } finally {
      setMarkingTee(false);
    }
  }

  async function turnOff() {
    if (!ctx || !deviceToken) return;
    stopWatchRef.current?.();
    stopWatchRef.current = null;
    queueRef.current = [];
    persistQueue(ctx.registration.id, queueRef.current);
    await revokeConsent(deviceToken).catch(() => {});
    setConsent('declined');
  }

  async function onSubmitScore() {
    if (!deviceToken) return;
    setBusy(true);
    setScoreResult('');
    try {
      await flush(); // contemporaneous points must be server-side before labeling
      const res = await submitScoreApi({ deviceToken, holeNumber: currentHole, strokes });
      if (!res.ok) throw new Error((res.data.error as string) || 'Score submission failed');
      const labeled = (res.data.labeledPoints as number) ?? 0;
      const labelPart = labeled > 0
        ? `green for hole ${currentHole} labeled from ${labeled} GPS point${labeled === 1 ? '' : 's'}`
        : 'no recent GPS points to label';
      setScoreResult(res.data.scoreStored ? `Score saved — ${labelPart}.` : `Score NOT stored (database not ready) — ${labelPart}.`);
    } catch (e) {
      setScoreResult(e instanceof Error ? e.message : 'Score submission failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <SafeAreaView style={s.page}><ActivityIndicator style={{ marginTop: 60 }} color={colors.primary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={s.page} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
        <Text style={s.kicker}>{tournamentName || 'Live Round'}</Text>
        <Text style={s.title}>{ctx?.course?.name ?? 'Live Round · GPS'}</Text>

        {!ctx && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Whose round is this phone tracking?</Text>
            {regs.length === 0 && <Text style={s.dim}>No registrations yet — GPS collection starts once players register.</Text>}
            {regs.map((r) => (
              <Pressable key={r.id} onPress={() => pickRegistration(r)} disabled={busy} style={s.row}>
                <Text style={s.rowText}>{r.contact_name}</Text>
                <Text style={s.dim}>{r.registration_type}</Text>
              </Pressable>
            ))}
            {!!notice && <Text style={s.error}>{notice}</Text>}
          </View>
        )}

        {ctx && consent !== 'granted' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Helps map this course for future events</Text>
            <Text style={s.body}>
              With your permission, this phone logs its location every 15 seconds while you play — nothing else.
              That’s how tee, fairway, and green locations get mapped automatically, with no manual surveying.
              Your device will also ask for location permission; both are required.
            </Text>
            <Text style={s.dim}>Completely optional · only used to improve course maps, never sold · turn it off anytime.</Text>
            {!!notice && <Text style={s.error}>{notice}</Text>}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <Pressable onPress={agree} disabled={busy} style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.7 }]}>
                <Text style={s.primaryBtnText}>{busy ? 'Starting…' : 'I Agree — Start Tracking'}</Text>
              </Pressable>
              <Pressable onPress={() => setConsent('declined')} style={s.ghostBtn}>
                <Text style={s.ghostBtnText}>No Thanks</Text>
              </Pressable>
            </View>
          </View>
        )}

        {ctx && consent === 'granted' && (
          <>
            <View style={s.activeBanner}>
              <View>
                <Text style={s.activeText}>● GPS tracking active</Text>
                <Text style={s.dim}>{pingCount} points synced · queue {queueRef.current.length}</Text>
              </View>
              <Pressable onPress={turnOff}><Text style={s.link}>Turn off</Text></Pressable>
            </View>

            <View style={s.holeRow}>
              <Pressable onPress={() => changeHole(currentHole <= 1 ? (ctx.course?.totalHoles ?? 18) : currentHole - 1)} style={s.stepBtn}><Text style={s.stepText}>‹</Text></Pressable>
              <Text style={s.holeLabel}>Hole {currentHole} of {ctx.course?.totalHoles ?? 18}</Text>
              <Pressable onPress={() => changeHole(currentHole >= (ctx.course?.totalHoles ?? 18) ? 1 : currentHole + 1)} style={s.stepBtn}><Text style={s.stepText}>›</Text></Pressable>
            </View>

            <View style={s.card}>
              <Text style={s.scoreKicker}>Score for hole {currentHole}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Pressable onPress={() => setStrokes((n) => Math.max(1, n - 1))} style={s.stepBtn}><Text style={s.stepText}>−</Text></Pressable>
                <Text style={s.strokes}>{strokes}</Text>
                <Pressable onPress={() => setStrokes((n) => Math.min(20, n + 1))} style={s.stepBtn}><Text style={s.stepText}>+</Text></Pressable>
                <Pressable onPress={onSubmitScore} disabled={busy} style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.7 }]}>
                  <Text style={s.primaryBtnText}>{busy ? 'Submitting…' : 'Submit score'}</Text>
                </Pressable>
              </View>
              {!!scoreResult && (
                <Text style={[s.body, { marginTop: 10, color: scoreResult.startsWith('Score saved') ? colors.green : colors.alert }]}>
                  {scoreResult}
                </Text>
              )}
              <Pressable onPress={onMarkTee} disabled={markingTee} style={[s.markTeeBtn, markingTee && { opacity: 0.7 }]}>
                <Text style={s.markTeeText}>⛳  {markingTee ? 'Reading location…' : 'Mark tee box here'}</Text>
              </Pressable>
              {!!teeResult && (
                <Text style={[s.body, { marginTop: 8, color: teeResult.startsWith('Tee box') ? colors.green : colors.alert }]}>
                  {teeResult}
                </Text>
              )}
            </View>
          </>
        )}

        {ctx && consent === 'declined' && (
          <View style={[s.card, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
            <Text style={s.dim}>GPS tracking is off</Text>
            <Pressable onPress={() => { setNotice(''); setConsent('unknown'); }}><Text style={s.link}>Turn on</Text></Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  kicker: { fontFamily: font.sans, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase', color: colors.muted, marginBottom: 4 },
  title: { fontFamily: font.serif, fontSize: 24, fontWeight: '700', color: colors.ink, marginBottom: 16 },
  card: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 18, marginBottom: 16 },
  cardTitle: { fontFamily: font.serif, fontSize: 17, fontWeight: '700', color: colors.ink, marginBottom: 10 },
  body: { fontFamily: font.sans, fontSize: 13.5, lineHeight: 21, color: colors.ink, marginBottom: 8 },
  dim: { fontFamily: font.sans, fontSize: 12.5, color: colors.muted },
  error: { fontFamily: font.sans, fontSize: 12.5, color: colors.alert, marginTop: 8 },
  link: { fontFamily: font.sans, fontSize: 12.5, color: colors.primary, textDecorationLine: 'underline' },
  row: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowText: { fontFamily: font.sans, fontSize: 14.5, fontWeight: '600', color: colors.ink },
  primaryBtn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  primaryBtnText: { fontFamily: font.sans, color: '#fff', fontWeight: '700', fontSize: 14 },
  ghostBtn: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center' },
  ghostBtnText: { fontFamily: font.sans, color: colors.muted, fontWeight: '600', fontSize: 14 },
  activeBanner: { backgroundColor: '#EAF2ED', borderWidth: 1, borderColor: '#C8DDD1', borderRadius: 12, padding: 14, marginBottom: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  activeText: { fontFamily: font.sans, fontWeight: '700', color: colors.green, fontSize: 13.5 },
  holeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 16 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 16, color: colors.ink },
  holeLabel: { fontFamily: font.sans, fontWeight: '700', fontSize: 14, color: colors.ink, minWidth: 110, textAlign: 'center' },
  scoreKicker: { fontFamily: font.sans, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: colors.muted, marginBottom: 10 },
  strokes: { fontFamily: font.serif, fontSize: 22, fontWeight: '700', color: colors.ink, minWidth: 28, textAlign: 'center' },
  markTeeBtn: { marginTop: 12, paddingVertical: 11, borderRadius: 10, borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center' },
  markTeeText: { fontFamily: font.sansBold, fontSize: 13.5, color: colors.primary },
});
