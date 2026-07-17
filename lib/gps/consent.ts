import type { SupabaseClient } from '@supabase/supabase-js';

// A device's consent is the event with the newest created_at in
// gps_consent_events. We compute that latest-per-device directly from the
// raw log rather than through the gps_active_consent view: a view read via
// PostgREST .maybeSingle() throws if the view ever returns more than one row
// for a device, and any such glitch would silently read as "no consent"
// (breaking collection) or miscount active devices on the admin dashboard.
// Reading the raw log with an explicit newest-first limit is unambiguous.

export async function isDeviceConsented(
  supabase: SupabaseClient,
  deviceId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('gps_consent_events')
    .select('event')
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.event === 'granted';
}

// Device ids whose latest consent event is 'granted', across all devices.
// Used by the admin dashboard's active-device count.
export async function activeConsentDeviceIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data } = await supabase
    .from('gps_consent_events')
    .select('device_id, event, created_at')
    .order('created_at', { ascending: true });

  // Ascending order → the last write for each device wins, i.e. its latest event.
  const latestByDevice = new Map<string, string>();
  for (const e of data ?? []) latestByDevice.set(e.device_id, e.event);

  return [...latestByDevice.entries()]
    .filter(([, event]) => event === 'granted')
    .map(([deviceId]) => deviceId);
}
