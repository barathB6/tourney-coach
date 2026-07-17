import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { config } from './config';

// Native Supabase client. AsyncStorage persists the session across app
// launches (the web app relies on localStorage for the same thing).
// detectSessionInUrl is false because there's no browser URL to parse — the
// native Google flow hands us an idToken directly (see lib/auth.tsx).
export const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
