import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import { useTournament } from '../../lib/useTournament';
import { supabase } from '../../lib/supabase';
import { colors, font } from '../../lib/theme';

const MUTED = '#5C6B62';

type Volunteer = { id: string; name: string; email: string; phone: string | null; role: string | null };

export default function VolunteersScreen() {
  const { tournament, loading: tLoading } = useTournament();
  const [volunteers, setVolunteers] = useState<Volunteer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tournament) return;
    const { data } = await supabase
      .from('volunteer_signups')
      .select('id, name, email, phone, role')
      .eq('tournament_id', tournament.id)
      .order('created_at', { ascending: false });
    setVolunteers(data ?? []);
  }, [tournament]);

  useEffect(() => { if (!tLoading) load().finally(() => setLoading(false)); }, [tLoading, load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const roleCount = new Set(volunteers.map((v) => v.role).filter(Boolean)).size;

  return (
    <SafeAreaView style={s.page} edges={['top']}>
      <ScreenHeader title="Volunteers" subtitle={tournament?.name} />
      {loading || tLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : (
        <FlatList
          data={volunteers}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListHeaderComponent={
            <View style={s.summary}>
              <Text style={s.summaryText}>{volunteers.length} volunteer{volunteers.length === 1 ? '' : 's'}{roleCount ? ` · ${roleCount} role${roleCount === 1 ? '' : 's'} covered` : ''}</Text>
            </View>
          }
          ListEmptyComponent={<Text style={s.empty}>No volunteers signed up yet.</Text>}
          renderItem={({ item }) => (
            <View style={s.row}>
              <View style={s.avatar}><Text style={s.avatarText}>{item.name.slice(0, 1).toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name}</Text>
                <Text style={s.meta}>{[item.email, item.phone].filter(Boolean).join(' · ')}</Text>
              </View>
              {!!item.role && <View style={s.roleBadge}><Text style={s.roleText}>{item.role}</Text></View>}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  summary: { marginBottom: 12 },
  summaryText: { fontFamily: font.sansMedium, fontSize: 13, color: MUTED },
  empty: { fontFamily: font.sans, fontSize: 14, color: MUTED, textAlign: 'center', marginTop: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 14, marginBottom: 10 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.greenSoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: font.serif, fontSize: 16, color: colors.primary },
  name: { fontFamily: font.sansBold, fontSize: 15, color: colors.ink },
  meta: { fontFamily: font.sans, fontSize: 12.5, color: MUTED, marginTop: 2 },
  roleBadge: { backgroundColor: colors.greenSoft, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  roleText: { fontFamily: font.sansBold, fontSize: 11, color: colors.primary },
});
