import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { colors, font } from '../../lib/theme';

type Tournament = {
  id: string;
  name: string;
  event_date: string | null;
  format: string | null;
  max_players: number | null;
};

export default function DashboardScreen() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [regCount, setRegCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const firstName =
    (session?.user.user_metadata?.full_name || session?.user.user_metadata?.name || session?.user.email || 'there')
      .toString().split(' ')[0];

  const load = useCallback(async () => {
    setError(null);
    const uid = session?.user.id;
    if (!uid) return;
    const { data: t, error: tErr } = await supabase
      .from('tournaments')
      .select('id, name, event_date, format, max_players')
      .eq('organizer_id', uid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tErr) { setError(tErr.message); return; }
    setTournament(t);
    if (t) {
      const { count } = await supabase
        .from('registrations')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', t.id);
      setRegCount(count ?? 0);
    } else {
      setRegCount(0);
    }
  }, [session]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  const eventDate = tournament?.event_date
    ? new Date(tournament.event_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <SafeAreaView style={styles.page} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={styles.topbar}>
          <Text style={styles.brand}>TourneyCoach</Text>
          <Pressable onPress={signOut} hitSlop={8}>
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>

        <Text style={styles.greeting}>Welcome back, {firstName}.</Text>

        {error && <Text style={styles.error}>{error}</Text>}

        {tournament ? (
          <>
            <View style={styles.card}>
              <Text style={styles.eyebrow}>YOUR TOURNAMENT</Text>
              <Text style={styles.tName}>{tournament.name}</Text>
              <Text style={styles.tMeta}>
                {[eventDate, tournament.format, tournament.max_players ? `${tournament.max_players} players` : null]
                  .filter(Boolean).join(' · ')}
              </Text>
            </View>

            <View style={styles.statRow}>
              <View style={styles.stat}>
                <Text style={styles.statVal}>{regCount}</Text>
                <Text style={styles.statLabel}>Registrations</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statVal}>{tournament.max_players ? Math.max(0, tournament.max_players - regCount) : '—'}</Text>
                <Text style={styles.statLabel}>Spots left</Text>
              </View>
            </View>
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.tName}>No tournament yet</Text>
            <Text style={styles.tMeta}>Create your first event on tourneycoach.com to see it here.</Text>
          </View>
        )}

        <Pressable onPress={() => router.push('/live')} style={styles.liveCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.liveTitle}>Live Round · GPS</Text>
            <Text style={styles.liveSub}>Consent-gated course mapping during play</Text>
          </View>
          <Text style={styles.liveArrow}>›</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>JUMP BACK IN</Text>
        <View style={styles.tiles}>
          {[
            ['Cause story', 'Tell your why'],
            ['Registration', 'Manage your field'],
            ['Sponsors', 'Line up support'],
            ['AI Coach', 'Ask anything'],
          ].map(([title, sub]) => (
            <View key={title} style={styles.tile}>
              <Text style={styles.tileTitle}>{title}</Text>
              <Text style={styles.tileSub}>{sub}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.footNote}>
          Porting more screens next — coach, registration, sponsors, GPS. Same account, same data.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 20, paddingBottom: 48 },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  brand: { fontFamily: font.serif, fontSize: 20, color: colors.deepGreen },
  signOut: { fontFamily: font.sansMedium, fontSize: 13.5, color: colors.muted },
  greeting: { fontFamily: font.serif, fontSize: 24, color: colors.ink, marginBottom: 16 },
  error: { fontFamily: font.sans, fontSize: 13, color: colors.alert, marginBottom: 12 },
  card: { backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 18, marginBottom: 14 },
  eyebrow: { fontFamily: font.sansBold, fontSize: 11, letterSpacing: 1, color: colors.muted, marginBottom: 4 },
  tName: { fontFamily: font.serif, fontSize: 22, color: colors.ink, marginBottom: 4 },
  tMeta: { fontFamily: font.sans, fontSize: 14, color: colors.muted },
  statRow: { flexDirection: 'row', gap: 12, marginBottom: 22 },
  stat: { flex: 1, backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 16 },
  statVal: { fontFamily: font.serif, fontSize: 28, color: colors.ink },
  statLabel: { fontFamily: font.sans, fontSize: 12.5, color: colors.muted, marginTop: 2 },
  sectionLabel: { fontFamily: font.sansBold, fontSize: 11, letterSpacing: 1, color: colors.muted, marginBottom: 10 },
  liveCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.greenSoft, borderWidth: 1, borderColor: colors.greenBorder, borderRadius: 14, padding: 16, marginBottom: 20 },
  liveTitle: { fontFamily: font.sansBold, fontSize: 15, color: colors.deepGreen },
  liveSub: { fontFamily: font.sans, fontSize: 12.5, color: colors.muted, marginTop: 2 },
  liveArrow: { fontSize: 22, color: colors.green, marginLeft: 8 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: '47%', flexGrow: 1, backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 16 },
  tileTitle: { fontFamily: font.sansBold, fontSize: 15, color: colors.ink },
  tileSub: { fontFamily: font.sans, fontSize: 13, color: colors.muted, marginTop: 2 },
  footNote: { fontFamily: font.sans, fontSize: 12.5, color: colors.faint, marginTop: 26, lineHeight: 18 },
});
