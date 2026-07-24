import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import ScreenHeader from '../../components/ScreenHeader';
import { useTournament } from '../../lib/useTournament';
import { supabase } from '../../lib/supabase';
import { colors, font } from '../../lib/theme';

const MUTED = '#5C6B62';

type Reg = {
  id: string;
  registration_type: string;
  team_name: string | null;
  contact_name: string;
  total_amount_cents: number;
  payment_status: string;
  foursome_number: number | null;
  starting_hole: number | null;
};

const TYPE_LABEL: Record<string, string> = { foursome: 'Foursome', single: 'Single', sponsor: 'Sponsor' };
const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  paid: { bg: '#E4F0E8', fg: '#1B6B3A' },
  pending: { bg: '#FBF3E0', fg: '#8A6D1F' },
  failed: { bg: '#FEECEC', fg: '#B91C1C' },
  refunded: { bg: '#EEEAE0', fg: '#7A7264' },
};

export default function RegistrationsScreen() {
  const router = useRouter();
  const { tournament, loading: tLoading } = useTournament();
  const [regs, setRegs] = useState<Reg[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tournament) return;
    const { data } = await supabase
      .from('registrations')
      .select('id, registration_type, team_name, contact_name, total_amount_cents, payment_status, foursome_number, starting_hole')
      .eq('tournament_id', tournament.id)
      .order('created_at', { ascending: false });
    setRegs(data ?? []);
  }, [tournament]);

  useEffect(() => { if (!tLoading) load().finally(() => setLoading(false)); }, [tLoading, load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const paidCount = regs.filter((r) => r.payment_status === 'paid').length;
  const collected = regs.filter((r) => r.payment_status === 'paid').reduce((s, r) => s + r.total_amount_cents, 0);

  return (
    <SafeAreaView style={s.page} edges={['top']}>
      <ScreenHeader title="Registrations" subtitle={tournament?.name} />
      {loading || tLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
      ) : (
        <FlatList
          data={regs}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListHeaderComponent={
            <View style={s.summary}>
              <Text style={s.summaryText}>{regs.length} registration{regs.length === 1 ? '' : 's'} · {paidCount} paid · ${(collected / 100).toFixed(2)} collected</Text>
            </View>
          }
          ListEmptyComponent={<Text style={s.empty}>No registrations yet.</Text>}
          renderItem={({ item }) => {
            const sc = STATUS_COLOR[item.payment_status] ?? STATUS_COLOR.refunded;
            const scorable = item.registration_type !== 'sponsor';
            return (
              <Pressable
                onPress={scorable ? () => router.push({ pathname: '/scorecard', params: { reg: item.id } }) : undefined}
                style={({ pressed }) => [s.row, pressed && scorable && { opacity: 0.6 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{item.contact_name}</Text>
                  <Text style={s.meta}>
                    {TYPE_LABEL[item.registration_type] ?? item.registration_type}
                    {item.team_name ? ` · ${item.team_name}` : ''}
                    {item.starting_hole ? ` · Hole ${item.starting_hole}` : item.foursome_number ? ` · #${item.foursome_number}` : ''}
                  </Text>
                  {scorable && <Text style={s.tapHint}>Tap to view scorecard</Text>}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={s.amount}>${(item.total_amount_cents / 100).toFixed(2)}</Text>
                  <View style={[s.badge, { backgroundColor: sc.bg }]}><Text style={[s.badgeText, { color: sc.fg }]}>{item.payment_status}</Text></View>
                </View>
              </Pressable>
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
  tapHint: { fontFamily: font.sans, fontSize: 11, color: colors.green, marginTop: 3 },
  name: { fontFamily: font.sansBold, fontSize: 15, color: colors.ink },
  meta: { fontFamily: font.sans, fontSize: 12.5, color: MUTED, marginTop: 2 },
  amount: { fontFamily: font.serif, fontSize: 15, color: colors.ink },
  badge: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  badgeText: { fontFamily: font.sansBold, fontSize: 10.5, textTransform: 'capitalize' },
});
