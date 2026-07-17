import { Stack } from 'expo-router';

// The root navigator (app/_layout.tsx) already redirects signed-out users to
// /sign-in, so this group only ever renders for an authenticated session.
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#FAF8F3' } }} />;
}
