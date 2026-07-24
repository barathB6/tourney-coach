import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { colors, font } from '../../lib/theme';

type Tournament = {
  id: string;
  name: string;
  event_date: string | null;
  format: string | null;
  max_players: number | null;
  cause_story: string | null;
};

// Web dashboard uses this softer green-gray for secondary text; mirror it.
const MUTED = '#5C6B62';
const COACH_LABEL = '#A9D9BD';
const GOLD_TEXT = '#2E1F04';

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  return Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / 86400000));
}
function fmtDate(date: string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const openWeb = (path: string) => WebBrowser.openBrowserAsync(`https://www.tourneycoach.com${path}`);

export default function DashboardScreen() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [regCount, setRegCount] = useState(0);
  const [phase2Dismissed, setPhase2Dismissed] = useState(false);

  const fullName = (session?.user.user_metadata?.full_name || session?.user.user_metadata?.name || session?.user.email || 'there').toString();
  const firstName = fullName.split(' ')[0];
  const initials = fullName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase();

  const load = useCallback(async () => {
    const uid = session?.user.id;
    if (!uid) return;
    const { data: t } = await supabase
      .from('tournaments')
      .select('id, name, event_date, format, max_players, cause_story')
      .eq('organizer_id', uid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setTournament(t);
    if (t) {
      const { count } = await supabase
        .from('registrations')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', t.id)
        .in('payment_status', ['pending', 'paid']);
      setRegCount(count ?? 0);
    } else {
      setRegCount(0);
    }
  }, [session]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  if (loading) {
    return <SafeAreaView style={s.center}><ActivityIndicator color={colors.primary} /></SafeAreaView>;
  }

  const setupDone = !!tournament;
  const causeStoryDone = !!tournament?.cause_story;
  const steps: { label: string; done: boolean; path?: string | null; native?: '/live' | '/volunteers' | '/registrations' | '/sponsors' }[] = [
    { label: 'Tell your cause story', done: causeStoryDone, path: '/story' },
    { label: 'Set up the event details', done: setupDone, path: '/setup/format' },
    { label: 'Open registration', done: setupDone, path: null },
    { label: 'Line up your sponsors', done: false, path: '/sponsors' },
    { label: 'Build your day-of game plan', done: true, path: '/shotgun' },
    { label: 'Rally your volunteers', done: false, native: '/volunteers' },
  ];
  const activeIdx = steps.findIndex((st) => !st.done);
  const days = daysUntil(tournament?.event_date ?? null);
  const weeks = days !== null ? Math.ceil(days / 7) : null;
  const foursomes = tournament?.max_players ? Math.floor(tournament.max_players / 4) : 18;
  const filled = regCount;

  const coachMsg = activeIdx === 0
    ? `Welcome back, ${firstName}. The heart of every great tournament is the story of why. Let's write yours first — it's what makes sponsors say yes and players show up.`
    : activeIdx === 1
    ? `Cause story locked in, ${firstName}. Now set up your event details — format, field size, date, and pricing.`
    : `You're building momentum, ${firstName}. Keep going — the next step is small enough to finish before lunch.`;
  const coachBtnLabel = activeIdx === 0 ? 'Start your cause story' : activeIdx === 1 ? 'Set up event details' : 'Continue';
  const coachBtnPath = steps[activeIdx]?.path;

  const ACTIONS = [
    { label: 'AI Coach', native: '/coach' as const },
    { label: 'Volunteers', native: '/volunteers' as const },
    { label: 'Registrations', native: '/registrations' as const },
    { label: 'Sponsors', native: '/sponsors' as const },
    { label: 'Microsite', path: '/dashboard/microsite' },
    { label: 'Share', path: '/dashboard/share' },
    { label: 'Shotgun Start', path: '/shotgun' },
    { label: 'Course Builder', path: '/course/new' },
    { label: 'GPS', native: '/live' as const },
  ];

  const JUMP = [
    { label: 'Cause story', sub: causeStoryDone ? 'done' : 'not started', path: '/story' },
    { label: 'Event setup', sub: setupDone ? 'done' : 'not started', path: '/setup/format' },
    { label: 'Registration', sub: setupDone ? 'view registrations' : 'not started', native: '/registrations' as const },
    { label: 'Sponsors', sub: setupDone ? 'view sponsors' : 'not started', native: '/sponsors' as const },
    { label: 'Volunteers', sub: 'view signups', native: '/volunteers' as const },
    { label: 'Live Round · GPS', sub: 'course mapping', native: '/live' as const },
  ];

  return (
    <SafeAreaView style={s.page} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Topbar */}
        <View style={s.topbar}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
              <View style={s.mark}><Text style={s.markText}>⛳</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.brand}>TourneyCoach</Text>
                {tournament && (
                  <Text style={s.tMeta} numberOfLines={1}>
                    {tournament.name} · {[fmtDate(tournament.event_date), tournament.format].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </View>
            </View>
            <Pressable onPress={signOut} hitSlop={8}><Text style={s.signOut}>Sign out</Text></Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 12 }}>
            {ACTIONS.map((a) => (
              <Pressable key={a.label} onPress={() => ('native' in a && a.native) ? router.push(a.native) : openWeb(a.path!)} style={s.chip}>
                <Text style={s.chipText}>{a.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <Text style={s.stripH1}>One surface, every stage.</Text>
        <Text style={s.stripP}>Your organizer dashboard re-weights itself as the event moves</Text>

        {/* ── STAGE 1 · SETUP ── */}
        <View style={s.phase}>
          <View style={s.phead}>
            <View style={s.ptag}><Text style={s.ptagText}>Stage 1 · Setup</Text></View>
            <Text style={s.clock}>{weeks !== null ? `${weeks} weeks to tee off` : '—'}</Text>
          </View>
          <View style={s.pbody}>
            <View style={s.coach}>
              <View style={s.coachEy}><Text style={s.coachLabel}>▸ FROM YOUR COACH</Text></View>
              <Text style={s.coachMsg}>{coachMsg}</Text>
              {coachBtnPath && (
                <Pressable style={s.btnGold} onPress={() => openWeb(coachBtnPath)}><Text style={s.btnGoldText}>{coachBtnLabel}</Text></Pressable>
              )}
            </View>

            <View>
              <Text style={s.blockH}>YOUR GAME PLAN</Text>
              <View style={{ position: 'relative', marginTop: 6 }}>
                <View style={s.spine} />
                {steps.map((st, i) => {
                  const isNow = i === activeIdx;
                  return (
                    <Pressable key={st.label} onPress={() => st.native ? router.push(st.native) : st.path ? openWeb(st.path) : undefined} style={s.stepRow}>
                      <View style={[s.dot, st.done ? s.dotDone : isNow ? s.dotNow : s.dotTodo]}>
                        <Text style={st.done ? s.dotDoneText : isNow ? s.dotNowText : s.dotTodoText}>{st.done ? '✓' : isNow ? '▸' : `${i + 1}`}</Text>
                      </View>
                      <View style={{ flex: 1, paddingTop: 3, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        <Text style={[s.stepText, { color: st.done ? MUTED : isNow ? colors.ink : MUTED, fontFamily: isNow ? font.sansBold : font.sans }]}>{st.label}</Text>
                        {isNow && <View style={s.hereTag}><Text style={s.hereTagText}>YOU'RE HERE</Text></View>}
                        {st.done && <Text style={s.doneTag}>done</Text>}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={s.note}>
              <Text style={s.noteText}>First-year tournaments usually raise <Text style={{ fontFamily: font.sansBold, color: colors.ink }}>$5,000–$15,000</Text>. We'll take it one step at a time and aim higher together — no rush, no pressure.</Text>
            </View>

            <View>
              <Text style={s.blockH}>YOUR TEAM</Text>
              <Text style={[s.tMeta, { marginBottom: 8 }]}>Running this solo? That's how most great tournaments start.</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <View style={s.teamChip}>
                  <View style={s.chipAvi}><Text style={s.chipAviText}>{initials}</Text></View>
                  <Text style={{ fontFamily: font.sansBold, color: colors.ink, fontSize: 12.5 }}>You</Text>
                  <Text style={{ color: MUTED, fontSize: 12.5 }}>· everything</Text>
                </View>
                <Pressable onPress={() => openWeb('/dashboard')} style={s.addBtn}><Text style={s.addBtnText}>+ Invite someone to help</Text></Pressable>
              </View>
            </View>
          </View>
        </View>

        {/* ── STAGE 2 · BUILD THE FIELD & MONEY ── */}
        <View style={s.phase}>
          <View style={s.phead}>
            <View style={s.ptag}><Text style={s.ptagText}>Stage 2 · Build the field & money</Text></View>
            <Text style={s.clock}>{days !== null ? `${days} days to tee off` : '—'}</Text>
          </View>
          <View style={s.pbody}>
            <View style={s.tilesRow}>
              <View style={[s.tile, s.tileLead]}>
                <Text style={s.tileLab}>FIELD FILLED</Text>
                <Text style={s.tileNumWhite}>{filled}<Text style={{ fontSize: 15, opacity: 0.8 }}> / {foursomes}</Text></Text>
                <Text style={s.tileSubWhite}>foursomes · {Math.max(0, foursomes - filled)} to go</Text>
                <View style={s.bar}><View style={[s.barFill, { width: `${Math.min(100, (filled / foursomes) * 100)}%` }]} /></View>
              </View>
              <View style={[s.tile, s.tileLead]}>
                <Text style={s.tileLab}>RAISED SO FAR</Text>
                <Text style={s.tileNumWhite}>$0</Text>
                <Text style={s.tileSubWhite}>of goal TBD</Text>
                <View style={s.bar}><View style={[s.barFill, { width: '0%' }]} /></View>
              </View>
            </View>
            <View style={s.tilesRow}>
              <View style={[s.tile, s.tileBase]}>
                <Text style={s.tileLabDark}>SPONSORS</Text>
                <Text style={s.tileNumGreen}>0</Text>
                <Text style={s.tileSubDark}>none yet</Text>
              </View>
              <View style={[s.tile, s.tileBase]}>
                <Text style={s.tileLabDark}>DAYS LEFT</Text>
                <Text style={s.tileNumGreen}>{days ?? '—'}</Text>
                <Text style={s.tileSubDark}>{tournament ? `tee off ${fmtDate(tournament.event_date)}` : 'set up event first'}</Text>
              </View>
            </View>

            {!phase2Dismissed && (
              <View style={s.coach}>
                <View style={s.coachEy}><Text style={s.coachLabel}>▸ FROM YOUR COACH</Text></View>
                <Text style={s.coachMsg}>{setupDone
                  ? "You're ready to build the field. Open registration and start reaching out to sponsors — both happen in parallel."
                  : 'Finish Stage 1 first. Once your event details are locked in, registration opens up automatically.'}</Text>
                <View style={{ flexDirection: 'row', gap: 9, marginTop: 14, flexWrap: 'wrap' }}>
                  <Pressable style={s.btnGold} onPress={() => openWeb(setupDone && tournament ? `/register?id=${tournament.id}` : '/setup/format')}>
                    <Text style={s.btnGoldText}>{setupDone ? 'Open registration' : 'Complete Stage 1 first'}</Text>
                  </Pressable>
                  <Pressable style={s.btnGhost} onPress={() => setPhase2Dismissed(true)}><Text style={s.btnGhostText}>Maybe later</Text></Pressable>
                </View>
              </View>
            )}

            <View style={s.circle}>
              <Text style={s.circleBig}>347</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: colors.ink, fontFamily: font.sans }}>golfers within 35 miles want to hear about tournaments like yours.</Text>
                <Text style={{ fontSize: 11, color: MUTED, marginTop: 3, fontFamily: font.sans }}>One message, sent for you — about 1 in 4 click through. We never share their names or emails.</Text>
              </View>
            </View>

            <View>
              <Text style={s.blockH}>JUMP BACK IN</Text>
              <View style={s.jumpGrid}>
                {JUMP.map((j) => (
                  <Pressable key={j.label} onPress={() => ('native' in j && j.native) ? router.push(j.native) : openWeb(j.path!)} style={s.jumpTile}>
                    <Text style={s.jumpLabel}>{j.label}</Text>
                    <Text style={s.jumpSub}>{j.sub}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </View>

        <Text style={s.footer}><Text style={{ fontFamily: font.sansBold, color: colors.primary }}>TourneyCoach</Text> · Organizer Dashboard</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const card = { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 16 } as const;

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center' },

  topbar: { ...card, padding: 14, marginBottom: 18 },
  mark: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  markText: { fontSize: 18 },
  brand: { fontFamily: font.serif, fontSize: 19, color: colors.deepGreen },
  tMeta: { fontFamily: font.sans, fontSize: 12, color: MUTED, marginTop: 1 },
  signOut: { fontFamily: font.sansMedium, fontSize: 13, color: MUTED },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14, backgroundColor: '#fff' },
  chipText: { fontFamily: font.sansBold, fontSize: 12.5, color: colors.primary },

  stripH1: { fontFamily: font.serif, fontSize: 21, color: colors.ink, marginBottom: 2 },
  stripP: { fontFamily: font.sans, fontSize: 13, color: MUTED, marginBottom: 16 },

  phase: { ...card, marginBottom: 18, overflow: 'hidden' },
  phead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 15, borderBottomWidth: 1, borderBottomColor: colors.line },
  ptag: { backgroundColor: colors.greenSoft, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  ptagText: { fontFamily: font.sansBold, fontSize: 10.5, letterSpacing: 0.7, textTransform: 'uppercase', color: colors.primary },
  clock: { fontFamily: font.sansMedium, fontSize: 12, color: MUTED },
  pbody: { padding: 16, gap: 16 },

  coach: { backgroundColor: colors.deepGreen, borderRadius: 14, padding: 16 },
  coachEy: { marginBottom: 9 },
  coachLabel: { fontFamily: font.sansBold, fontSize: 10, letterSpacing: 1.3, color: COACH_LABEL },
  coachMsg: { fontFamily: font.sans, fontSize: 14.5, lineHeight: 22, color: '#fff' },
  btnGold: { backgroundColor: colors.gold, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, alignSelf: 'flex-start', marginTop: 14 },
  btnGoldText: { fontFamily: font.sansBold, fontSize: 13.5, color: GOLD_TEXT },
  btnGhost: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  btnGhostText: { fontFamily: font.sansBold, fontSize: 13.5, color: '#CFE9D8' },

  blockH: { fontFamily: font.sansBold, fontSize: 10.5, letterSpacing: 1, color: MUTED, marginBottom: 2 },

  spine: { position: 'absolute', left: 13, top: 14, bottom: 14, width: 2, backgroundColor: colors.line },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 7 },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  dotDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  dotNow: { backgroundColor: '#fff', borderColor: colors.alert },
  dotTodo: { backgroundColor: '#fff', borderColor: colors.line },
  dotDoneText: { color: '#fff', fontSize: 14, fontFamily: font.sansBold },
  dotNowText: { color: colors.alert, fontSize: 13, fontFamily: font.sansBold },
  dotTodoText: { color: MUTED, fontSize: 13, fontFamily: font.sansBold },
  stepText: { fontSize: 14 },
  hereTag: { borderWidth: 1, borderColor: '#E7C3BA', backgroundColor: '#FBEEEB', borderRadius: 999, paddingVertical: 2, paddingHorizontal: 7 },
  hereTagText: { fontFamily: font.sansBold, fontSize: 9, letterSpacing: 0.7, color: colors.alert },
  doneTag: { fontFamily: font.sansBold, fontSize: 11, color: colors.primary },

  note: { backgroundColor: colors.greenSoft, borderWidth: 1, borderColor: colors.greenBorder, borderRadius: 12, padding: 13 },
  noteText: { fontFamily: font.sans, fontSize: 13, lineHeight: 20, color: '#2C4537' },

  teamChip: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line, borderRadius: 999, paddingVertical: 4, paddingLeft: 5, paddingRight: 11 },
  chipAvi: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.greenSoft, alignItems: 'center', justifyContent: 'center' },
  chipAviText: { fontFamily: font.serif, fontSize: 10, color: colors.primary },
  addBtn: { borderWidth: 1, borderColor: colors.line, borderStyle: 'dashed', borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12 },
  addBtnText: { fontFamily: font.sansBold, fontSize: 12.5, color: colors.primary },

  tilesRow: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, borderRadius: 12, padding: 13 },
  tileLead: { backgroundColor: colors.primary },
  tileBase: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line },
  tileLab: { fontFamily: font.sansBold, fontSize: 10, letterSpacing: 0.8, color: 'rgba(255,255,255,0.8)' },
  tileLabDark: { fontFamily: font.sansBold, fontSize: 10, letterSpacing: 0.8, color: MUTED },
  tileNumWhite: { fontFamily: font.serif, fontSize: 26, color: '#fff', marginTop: 5 },
  tileNumGreen: { fontFamily: font.serif, fontSize: 26, color: colors.primary, marginTop: 5 },
  tileSubWhite: { fontFamily: font.sans, fontSize: 11.5, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
  tileSubDark: { fontFamily: font.sans, fontSize: 11.5, color: MUTED, marginTop: 2 },
  bar: { height: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.25)', marginTop: 9, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999, backgroundColor: colors.gold },

  circle: { flexDirection: 'row', gap: 13, alignItems: 'flex-start', borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 14 },
  circleBig: { fontFamily: font.serif, fontSize: 30, color: colors.primary },

  jumpGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 4 },
  jumpTile: { width: '48%', borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, backgroundColor: '#fff' },
  jumpLabel: { fontFamily: font.sansBold, fontSize: 13, color: colors.ink },
  jumpSub: { fontFamily: font.sans, fontSize: 11.5, color: MUTED, marginTop: 2 },

  footer: { fontFamily: font.sans, fontSize: 12, color: MUTED, textAlign: 'center', marginTop: 8 },
});
