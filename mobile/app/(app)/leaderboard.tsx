import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import { useTournament } from '../../lib/useTournament';
import { supabase } from '../../lib/supabase';
import { config } from '../../lib/config';
import { colors, font } from '../../lib/theme';

type Trend = { toPar: number; holes: number; direction: 'up' | 'down' | 'flat' } | null;
type Pace = 'green' | 'yellow' | 'red' | null;
type Row = {
  rank: number; tied: boolean; registrationId: string; teamName: string;
  holesCompleted: number; totalStrokes: number; toPar: number | null; players: string[]; trend: Trend; pace: Pace;
};
const PACE_COLOR: Record<string, string> = { green: '#1B9E4B', yellow: '#E0A32E', red: '#D1495B' };
type Board = {
  tournament: { name: string; format: string; status: string; parTotal: number | null };
  standings: Row[]; teamsTotal: number; contests: { holeNumber: number; type: string; winner: string | null; decided: boolean }[]; raisedCents: number;
};

const FORMAT: Record<string, string> = { scramble: 'Scramble', best_ball: 'Best Ball', alternate_shot: 'Alternate Shot', stroke_play: 'Stroke Play' };
const toParText = (v: number | null) => (v == null ? '—' : v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`);
const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

// Native live leaderboard — same standings the web /leaderboard and TV board
// show, from the same /api/tournament/[id]/board endpoint (to-par ranking,
// USGA countback ties, recent-form trend). Auto-refreshes on a 20s poll + a
// realtime push, plus pull-to-refresh.
export default function LeaderboardScreen() {
  const { tournament } = useTournament();
  const tid = tournament?.id;
  const [board, setBoard] = useState<Board | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'notlive' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);
  const activeRef = useRef(true);

  const load = useCallback(async () => {
    if (!tid) return;
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/tournament/${tid}/board`, { headers: { 'cache-control': 'no-store' } });
      if (res.status === 404) { if (activeRef.current) setStatus('notlive'); return; }
      if (!res.ok) { if (activeRef.current) setStatus('error'); return; }
      const data = await res.json();
      if (activeRef.current) { setBoard(data); setStatus('ready'); }
    } catch {
      if (activeRef.current) setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
    }
  }, [tid]);

  useEffect(() => {
    activeRef.current = true;
    load();
    const poll = setInterval(load, 20000);
    const channel = tid
      ? supabase.channel(`leaderboard:${tid}`).on('broadcast', { event: 'score' }, () => load()).subscribe((s) => activeRef.current && setLive(s === 'SUBSCRIBED'))
      : null;
    return () => { activeRef.current = false; clearInterval(poll); if (channel) supabase.removeChannel(channel); };
  }, [tid, load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const anyScores = (board?.standings ?? []).some((s) => s.holesCompleted > 0);
  const decided = board?.contests.find((c) => c.decided && c.winner);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <ScreenHeader title="Leaderboard" subtitle={tournament?.name ?? 'Your tournament'} />

      {status === 'loading' && <View style={s.center}><ActivityIndicator color={colors.green} /></View>}
      {status === 'notlive' && <View style={s.center}><Text style={s.emptyTitle}>Not live yet</Text><Text style={s.emptyBody}>The leaderboard opens once you publish the event and teams start submitting scores.</Text></View>}
      {status === 'error' && <View style={s.center}><Text style={s.emptyBody}>Could not load the leaderboard. Pull to try again.</Text></View>}

      {status === 'ready' && board && (
        <>
          <View style={s.meta}>
            <View style={s.metaLeft}>
              <Text style={s.format}>{FORMAT[board.tournament.format] ?? board.tournament.format}{board.tournament.parTotal ? ` · Par ${board.tournament.parTotal}` : ''} · {board.teamsTotal} team{board.teamsTotal === 1 ? '' : 's'}</Text>
            </View>
            <View style={[s.livePill, { backgroundColor: live ? colors.greenSoft : '#F1ECDD', borderColor: live ? colors.greenBorder : colors.line }]}>
              <View style={[s.dot, { backgroundColor: live ? colors.green : colors.faint }]} />
              <Text style={[s.liveText, { color: live ? colors.green : colors.faint }]}>{live ? 'Live' : 'Polling'}</Text>
            </View>
          </View>

          {!anyScores ? (
            <FlatList
              data={[]} renderItem={null}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.green} />}
              ListEmptyComponent={<View style={s.center}><Text style={s.emptyTitle}>No scores yet</Text><Text style={s.emptyBody}>Standings appear the moment the first team submits a hole.</Text></View>}
            />
          ) : (
            <FlatList
              data={board.standings}
              keyExtractor={(r) => r.registrationId}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.green} />}
              contentContainerStyle={{ paddingBottom: 16 }}
              ListHeaderComponent={
                <View style={s.hrow}>
                  <Text style={[s.h, { width: 46 }]}>POS</Text>
                  <Text style={[s.h, { flex: 1 }]}>TEAM</Text>
                  <Text style={[s.h, s.num, { width: 46 }]}>THRU</Text>
                  <Text style={[s.h, s.num, { width: 54 }]}>SCORE</Text>
                  <Text style={[s.h, s.num, { width: 46 }]}>TREND</Text>
                </View>
              }
              renderItem={({ item: r }) => (
                <View style={s.row}>
                  <Text style={[s.pos, { width: 46, color: r.rank === 1 ? colors.gold : colors.ink }]}>{r.holesCompleted === 0 ? '—' : `${r.tied ? 'T-' : ''}${r.rank}`}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.team} numberOfLines={1}>{r.teamName}</Text>
                    {r.players.length > 0 && <Text style={s.players} numberOfLines={1}>{r.players.join(' · ')}</Text>}
                  </View>
                  <View style={{ width: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5 }}>
                    {r.pace && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: PACE_COLOR[r.pace] }} />}
                    <Text style={[s.cell, s.num, { color: colors.muted }]}>{r.holesCompleted === 0 ? '—' : r.holesCompleted === 18 ? 'F' : r.holesCompleted}</Text>
                  </View>
                  <Text style={[s.score, s.num, { width: 54, color: (r.toPar ?? 0) < 0 ? colors.alert : colors.ink }]}>{r.holesCompleted === 0 ? '—' : toParText(r.toPar)}</Text>
                  <Text style={[s.cell, s.num, { width: 46, color: !r.trend || r.trend.direction === 'flat' ? colors.faint : r.trend.direction === 'up' ? colors.green : colors.alert }]}>
                    {!r.trend || r.trend.direction === 'flat' ? '—' : `${r.trend.direction === 'up' ? '↑' : '↓'}${Math.abs(r.trend.toPar)}`}
                  </Text>
                </View>
              )}
              ListFooterComponent={
                <View style={s.footer}>
                  {decided && <Text style={s.footText}>{decided.type === 'hole_in_one' ? 'Hole-in-One' : decided.type === 'closest_to_pin' ? 'Closest to Pin' : 'Long Drive'} · {decided.winner} · Hole {decided.holeNumber}</Text>}
                  {board.raisedCents > 0 && <Text style={s.footText}>Raised live · <Text style={{ color: colors.gold, fontFamily: font.sansBold }}>{money(board.raisedCents)}</Text></Text>}
                  <Text style={s.footFine}>Updates automatically · ties broken by USGA scorecard countback</Text>
                </View>
              }
            />
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyTitle: { fontFamily: font.serif, fontSize: 20, color: colors.ink },
  emptyBody: { fontFamily: font.sans, fontSize: 14, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  metaLeft: { flex: 1 },
  format: { fontFamily: font.sansMedium, fontSize: 12.5, color: colors.muted },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  liveText: { fontFamily: font.sansBold, fontSize: 11.5 },
  hrow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#FAF8F3', borderBottomWidth: 1, borderBottomColor: colors.line },
  h: { fontFamily: font.sansBold, fontSize: 10.5, letterSpacing: 0.6, color: colors.muted },
  num: { textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1ECDD', backgroundColor: '#fff' },
  pos: { fontFamily: font.serif, fontSize: 17 },
  team: { fontFamily: font.sansBold, fontSize: 14.5, color: colors.ink },
  players: { fontFamily: font.sans, fontSize: 11.5, color: colors.faint, marginTop: 1 },
  cell: { fontFamily: font.sans, fontSize: 14 },
  score: { fontFamily: font.serif, fontSize: 17 },
  footer: { padding: 16, gap: 4, alignItems: 'center' },
  footText: { fontFamily: font.sansMedium, fontSize: 12.5, color: colors.muted },
  footFine: { fontFamily: font.sans, fontSize: 11, color: colors.faint, marginTop: 4, textAlign: 'center' },
});
