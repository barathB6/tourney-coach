import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { colors, font } from '../lib/theme';

export default function SignInScreen() {
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGoogle() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
      // On success the auth listener flips session and the root navigator
      // redirects into (app); nothing to do here.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.wrap}>
        <Text style={styles.brand}>TourneyCoach</Text>
        <Text style={styles.sub}>Sign in to get started</Text>

        <View style={styles.card}>
          <Pressable
            onPress={onGoogle}
            disabled={busy}
            style={({ pressed }) => [styles.googleBtn, (pressed || busy) && { opacity: 0.7 }]}
          >
            {busy ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <>
                <GoogleGlyph />
                <Text style={styles.googleText}>Sign in with Google</Text>
              </>
            )}
          </Pressable>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>

        <Text style={styles.legal}>
          AI-powered coaching for charity tournament organizers.
        </Text>
      </View>
    </SafeAreaView>
  );
}

// Simple four-color "G" so we don't pull an image asset just for the button.
function GoogleGlyph() {
  return (
    <View style={styles.glyph}>
      <Text style={styles.glyphText}>G</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  brand: { fontFamily: font.serif, fontSize: 34, color: colors.deepGreen },
  sub: { fontFamily: font.sans, fontSize: 15, color: colors.muted, marginTop: 6, marginBottom: 28 },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: colors.card, borderColor: colors.line,
    borderWidth: 1, borderRadius: 16, padding: 22, alignItems: 'center',
  },
  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderColor: colors.line, borderWidth: 1, borderRadius: 10, paddingVertical: 14,
    paddingHorizontal: 18, width: '100%', backgroundColor: '#fff',
  },
  glyph: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  glyphText: { fontFamily: font.sansBold, fontSize: 17, color: '#4285F4' },
  googleText: { fontFamily: font.sansMedium, fontSize: 15, color: colors.ink },
  error: { fontFamily: font.sans, fontSize: 13, color: colors.alert, marginTop: 14, textAlign: 'center' },
  legal: { fontFamily: font.sans, fontSize: 12.5, color: colors.faint, marginTop: 22, textAlign: 'center', maxWidth: 320 },
});
