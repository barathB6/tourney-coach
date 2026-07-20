import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ScreenHeader from '../../components/ScreenHeader';
import { useTournament } from '../../lib/useTournament';
import { supabase } from '../../lib/supabase';
import { colors, font } from '../../lib/theme';

const MUTED = '#5C6B62';

type Sponsor = {
  id: string;
  company: string;
  contact_name: string | null;
  status: string;
  amount_cents: number | null;
};

const STATUS_LABEL: Record<string, string> = {
  not_contacted: 'Not contacted', contacted: 'Contacted', verbal: 'Verbal yes',
  invoiced: 'Invoiced', paid: 'Paid', declined: 'Declined', no_reply: 'No reply',
};
const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  paid: { bg: '#E4F0E8', fg: '#1B6B3A' },
  verbal: { bg: '#E4F0E8', fg: '#1B6B3A' },
  invoiced: { bg: '#E4ECF5', fg: '#2563AA' },
  contacted: { bg: '#E4ECF5', fg: '#2563AA' },
  not_contacted: { bg: '#F0EDE4', fg: '#8A8172' },
  declined: { bg: '#FEECEC', fg: '#B91C1C' },
  no_reply: { bg: '#EEEAE0', fg: '#7A7264' },
};

export default function SponsorsScreen() {
  const { tournament, loading: tLoading } = useTournament();
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tournament) return;
    const { data } = await supabase
      .from('sponsors')
      .select('id, company, contact_name, status, amount_cents')
      .eq('tournament_id', tournament.id)
      .order('created_at', { ascending: false });
    setSponsors(data ?? []);
  }, [tournament]);

  useEffect(() => { if (!tLoading) load().finally(() => setLoading(false)); }, [tLoading, load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const committed = sponsors.filter((s) => ['verbal', 'invoiced', 'paid'].includes(s.status)).reduce((sum, s) => sum + (s.amount_cents ?? 0), 0);

  return (
    <SafeAreaView style={s.page} edges={['top']}>
      <ScreenHeader title="Sponsors" subtitle={tournament?.name} />
      {loading || tLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : (
        <FlatList
          data={sponsors}
          keyExtractor={(x) => x.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListHeaderComponent={
            <View style={s.summary}>
              <Text style={s.summaryText}>{sponsors.length} sponsor{sponsors.length === 1 ? '' : 's'} · ${(committed / 100).toLocaleString()} committed</Text>
            </View>
          }
          ListEmptyComponent={<Text style={s.empty}>No sponsors yet.</Text>}
          renderItem={({ item }) => {
            const sc = STATUS_COLOR[item.status] ?? STATUS_COLOR.not_contacted;
            return (
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{item.company}</Text>
                  {!!item.contact_name && <Text style={s.meta}>{item.contact_name}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  {item.amount_cents != null && <Text style={s.amount}>${(item.amount_cents / 100).toLocaleString()}</Text>}
                  <View style={[s.badge, { backgroundColor: sc.bg }]}><Text style={[s.badgeText, { color: sc.fg }]}>{STATUS_LABEL[item.status] ?? item.status}</Text></View>
                </View>
              </View>
            );
          }}
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
  name: { fontFamily: font.sansBold, fontSize: 15, color: colors.ink },
  meta: { fontFamily: font.sans, fontSize: 12.5, color: MUTED, marginTop: 2 },
  amount: { fontFamily: font.serif, fontSize: 15, color: colors.ink },
  badge: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  badgeText: { fontFamily: font.sansBold, fontSize: 10.5 },
});
