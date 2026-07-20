import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { supabase } from './supabase';

export type CurrentTournament = { id: string; name: string; max_players: number | null; event_date: string | null } | null;

// The organizer's newest tournament — the same one the dashboard surfaces.
// Shared by ported feature screens so they operate on a consistent event.
export function useTournament() {
  const { session } = useAuth();
  const [tournament, setTournament] = useState<CurrentTournament>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const uid = session?.user.id;
    if (!uid) { setLoading(false); return; }
    let cancelled = false;
    supabase
      .from('tournaments')
      .select('id, name, max_players, event_date')
      .eq('organizer_id', uid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setTournament(data);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [session]);

  return { tournament, loading };
}
