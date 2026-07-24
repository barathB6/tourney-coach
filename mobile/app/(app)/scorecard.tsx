import { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import ScreenHeader from '../../components/ScreenHeader';
import { config } from '../../lib/config';
import { colors, font } from '../../lib/theme';

type Hole = { holeNumber: number; par: number | null; strokes: number | null; toPar: number | null; runningToPar: number | null; contests: string[] };
type Card = {
  team: { name: string; players: string[] };
  tournament: { id: string | null; name: string | null };
  card: Hole[]; holesPlayed: number; totalStrokes: number; toPar: number | null;
};
const CONTEST_ICON: Record<string, string> = { hole_in_one: '⛳', closest_to_pin: '🎯', long_drive: '💥' };
const toParText = (v: number | null) => (v == null ? '' : v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);

// Native per-team scorecard — the same round review as the web /scorecard/[id],
// from /api/registration/[id]/scorecard. Front/back nine tables with par +
// score rows, contest markers, and running to-par.
export default function ScorecardScreen() {
  const { reg } = useLocalSearchParams<{ reg: string }>();
  const [data, setData] = useState<Card | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let active = true;
    if (!reg) { setStatus('error'); return; }
    fetch(`${config.apiBaseUrl}/api/registration/${reg}/scorecard`, { headers: { 'cache-control': 'no-store' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => { if (active) { setData(d); setStatus('ready'); } })
      .catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [reg]);

  const front = data?.card.filter((h) => h.holeNumber <= 9) ?? [];
  const back = data?.card.filter((h) => h.holeNumber > 9) ?? [];

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScreenHeader title="Scorecard" subtitle={data?.team.name ?? 'Round review'} />
      {status === 'loading' && <View style={s.center}><ActivityIndicator color={colors.green} /></View>}
      {status === 'error' && <View style={s.center}><Text style={s.emptyBody}>No scorecard yet — this team hasn&rsquo;t started, or the event isn&rsquo;t live.</Text></View>}
      {status === 'ready' && data && (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {data.team.players.length > 0 && <Text style={s.players}>{data.team.players.join(' · ')}</Text>}
          <Text style={s.summary}>
            {data.holesPlayed === 0 ? 'No holes scored yet' : `Thru ${data.holesPlayed} · ${data.totalStrokes} strokes`}
            {data.toPar != null && <Text style={{ color: data.toPar < 0 ? colors.alert : data.toPar > 0 ? colors.ink : colors.green }}>{`  ${toParText(data.toPar)}`}</Text>}
          </Text>

          {[{ label: 'Front 9', holes: front }, { label: 'Back 9', holes: back }].filter((n) => n.holes.length > 0).map((nine) => (
            <View key={nine.label} style={s.card}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                  <View style={[s.trow, s.thead]}>
                    <Text style={[s.cellLabel, s.headText]}>{nine.label}</Text>
                    {nine.holes.map((h) => (
                      <Text key={h.holeNumber} style={[s.cell, s.headText]}>{h.holeNumber}{h.contests.map((c) => CONTEST_ICON[c] ?? '').join('')}</Text>
                    ))}
                  </View>
                  <View style={s.trow}>
                    <Text style={[s.cellLabel, { color: colors.muted }]}>Par</Text>
                    {nine.holes.map((h) => <Text key={h.holeNumber} style={[s.cell, { color: colors.muted }]}>{h.par ?? '–'}</Text>)}
                  </View>
                  <View style={[s.trow, { borderBottomWidth: 0 }]}>
                    <Text style={[s.cellLabel, { fontFamily: font.sansBold }]}>Score</Text>
                    {nine.holes.map((h) => (
                      <Text key={h.holeNumber} style={[s.cell, { fontFamily: font.sansBold, color: h.strokes == null ? '#C9C2B0' : (h.toPar != null && h.toPar < 0) ? colors.alert : colors.ink }]}>{h.strokes ?? '·'}</Text>
                    ))}
                  </View>
                </View>
              </ScrollView>
            </View>
          ))}
          <Text style={s.fine}>Latest score per hole · corrections already applied</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyBody: { fontFamily: font.sans, fontSize: 14, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  players: { fontFamily: font.sans, fontSize: 13, color: colors.muted, marginBottom: 4 },
  summary: { fontFamily: font.sansBold, fontSize: 15, color: colors.ink, marginBottom: 16 },
  card: { backgroundColor: '#fff', borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 8, marginBottom: 14 },
  trow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#F1ECDD' },
  thead: { backgroundColor: '#FAF8F3', borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  headText: { fontFamily: font.sansBold, color: colors.ink },
  cellLabel: { width: 58, paddingVertical: 9, paddingHorizontal: 8, fontFamily: font.sans, fontSize: 13 },
  cell: { width: 40, paddingVertical: 9, textAlign: 'center', fontFamily: font.sans, fontSize: 14 },
  fine: { fontFamily: font.sans, fontSize: 11.5, color: colors.faint, textAlign: 'center', marginTop: 4 },
});
