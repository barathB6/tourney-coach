// Centralized access to the public runtime config. Throwing early with a
// clear message beats a confusing null-deref deep in the auth flow.
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env ${name} — set it in mobile/.env`);
  return value;
}

export const config = {
  supabaseUrl: required('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: required('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
  apiBaseUrl: (process.env.EXPO_PUBLIC_API_BASE_URL ?? 'https://www.tourneycoach.com').replace(/\/$/, ''),
  googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
  googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
};
