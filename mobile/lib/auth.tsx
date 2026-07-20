import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { getQueryParams } from 'expo-auth-session/build/QueryParams';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Auth uses the OAuth authorization-code/implicit web flow — the SAME flow
// the website uses — rather than a native Google SDK. This deliberately
// avoids @react-native-google-signin, which required an id_token nonce that
// Supabase rejected on iOS and a per-app SHA-1 Android OAuth client
// (DEVELOPER_ERROR). The web flow reuses the existing web Google client, so
// there is nothing to configure in Google Cloud per platform; Supabase just
// needs REDIRECT_URI in its redirect allow-list.
WebBrowser.maybeCompleteAuthSession();

// Deterministic native deep link back into the app (scheme set in app.json).
// This exact value must be added to Supabase → Auth → URL Configuration →
// Redirect URLs.
const REDIRECT_URI = Linking.createURL('auth-callback');

// The OAuth redirect may arrive at /auth-callback OR — on Android, where the
// browser dispatches it as a fresh deep link — at the scheme root with the
// tokens in the query or fragment. Match any of those so expo-router doesn't
// swallow it as an "unmatched route".
function isAuthRedirect(url: string): boolean {
  return url.includes('auth-callback') || /[#?&](access_token|code)=/.test(url);
}

// Supabase can return either tokens (implicit) or a code (PKCE) on the
// redirect URL depending on the client's flow type — handle both.
async function createSessionFromUrl(url: string): Promise<Session | null> {
  const { params, errorCode } = getQueryParams(url);
  if (errorCode) throw new Error(errorCode);

  if (params.access_token) {
    const { data, error } = await supabase.auth.setSession({
      access_token: params.access_token,
      refresh_token: params.refresh_token,
    });
    if (error) throw error;
    return data.session;
  }
  if (params.code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return data.session;
  }
  return null;
}

// Supabase recommends pausing token auto-refresh while backgrounded.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});

type AuthState = {
  session: Session | null;
  initializing: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitializing(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Catch the OAuth redirect deep link that expo-router would otherwise route
  // to a not-found page — both when the app is already open (event) and when
  // it's cold-started by the redirect (initial URL). On success the session
  // flips and RootNavigator redirects into (app).
  useEffect(() => {
    Linking.getInitialURL().then((url) => { if (url && isAuthRedirect(url)) createSessionFromUrl(url).catch(() => {}); });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (isAuthRedirect(url)) createSessionFromUrl(url).catch(() => {});
    });
    return () => sub.remove();
  }, []);

  async function signInWithGoogle() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: REDIRECT_URI, skipBrowserRedirect: true },
    });
    if (error) throw error;
    if (!data?.url) throw new Error('Could not start Google sign-in');

    const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URI);
    if (result.type === 'success') {
      await createSessionFromUrl(result.url);
    }
    // result.type 'cancel'/'dismiss' → user backed out; leave the screen as-is.
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ session, initializing, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
