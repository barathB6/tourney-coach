import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { config } from './config';

// Configure the native Google Sign-in SDK once. webClientId sets the idToken
// audience to the client Supabase's Google provider already trusts; iosClientId
// is what actually drives the iOS system sign-in sheet.
GoogleSignin.configure({
  webClientId: config.googleWebClientId,
  iosClientId: config.googleIosClientId || undefined,
});

// Supabase recommends pausing token auto-refresh while the app is
// backgrounded and resuming on foreground, so refreshes don't fire uselessly.
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

  async function signInWithGoogle() {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: false });
    const result = await GoogleSignin.signIn();
    // v16 returns { type: 'success' | 'cancelled', data }.
    if (result.type !== 'success') return; // user cancelled the sheet
    const idToken = result.data?.idToken;
    if (!idToken) throw new Error('No ID token returned from Google');
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error) throw error;
  }

  async function signOut() {
    try { await GoogleSignin.signOut(); } catch { /* not signed in with Google; ignore */ }
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
