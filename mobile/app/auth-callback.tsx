import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { getQueryParams } from 'expo-auth-session/build/QueryParams';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';

// Dedicated OAuth callback route. On Android (standalone) the browser dispatches
// the redirect as a fresh deep link — tourneycoach://auth-callback?code=… or
// #access_token=… — which expo-router resolves to THIS screen. Without a route
// here the deep link dead-ended on expo-router's "Unmatched Route" page and
// sign-in never completed. This screen exchanges the tokens/code for a session,
// then routes by the resulting session state (dashboard on success, sign-in on
// failure). Navigation is driven by the real session — never by a run-local flag
// — so a re-render when useURL() populates can't strand it on the spinner.
export default function AuthCallback() {
  const router = useRouter();
  const url = Linking.useURL();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // signInWithGoogle may have already completed the session via the in-app
        // auth session; only exchange if we don't have one (a PKCE code is
        // single-use, so a second exchange would fail).
        if (!(await supabase.auth.getSession()).data.session) {
          const target = url ?? (await Linking.getInitialURL());
          if (target) {
            const { params, errorCode } = getQueryParams(target);
            if (errorCode) throw new Error(errorCode);
            if (params.access_token) {
              await supabase.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token });
            } else if (params.code) {
              await supabase.auth.exchangeCodeForSession(params.code);
            }
          }
        }
      } catch {
        // Ignore — the session check below is the source of truth.
      }
      if (cancelled) return;
      const session = (await supabase.auth.getSession()).data.session;
      router.replace(session ? '/(app)' : '/sign-in');
    })();
    return () => { cancelled = true; };
  }, [url, router]);

  return (
    <View style={s.c}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const s = StyleSheet.create({
  c: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
});
