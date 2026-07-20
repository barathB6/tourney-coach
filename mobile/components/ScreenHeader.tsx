import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, font } from '../lib/theme';

// Shared native screen header: back chevron + title. The (app) Stack hides
// its own header, so ported feature screens render this.
export default function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const router = useRouter();
  return (
    <View style={s.wrap}>
      <Pressable onPress={() => router.back()} hitSlop={10} style={s.back}>
        <Text style={s.backText}>‹</Text>
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={s.subtitle} numberOfLines={1}>{subtitle}</Text>}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.cream },
  back: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.line, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 20, color: colors.ink, marginTop: -2 },
  title: { fontFamily: font.serif, fontSize: 20, color: colors.ink },
  subtitle: { fontFamily: font.sans, fontSize: 12.5, color: '#5C6B62', marginTop: 1 },
});
