'use client';

// Organizer shortcut to their own live TV board at a clean, memorable URL
// (/tv/leaderboard) — no tournament UUID to copy. Resolves the organizer's
// current tournament and renders the shared board inline, so the URL stays
// /tv/leaderboard. A first-time organizer with no tournament yet sees a real
// "get started" panel instead of a "not found" dead end.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { TVBoardView, TVShell } from '../[id]/page';

type State = { kind: 'loading' } | { kind: 'board'; id: string } | { kind: 'none' };

export default function TVLeaderboardShortcut() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/tv/leaderboard'); return; }

      // Show the tournament the organizer currently has open on the dashboard
      // — same key every other tournament-scoped page reads. Falls back to the
      // newest only when there's no selection (or it's been deleted), so the
      // board never silently belongs to a different event than the dashboard.
      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }

      const { data: all } = await supabase
        .from('tournaments').select('id').eq('organizer_id', user.id)
        .order('created_at', { ascending: false });

      const list = all ?? [];
      const picked = list.find((t) => t.id === selectedId) ?? list[0] ?? null;
      setState(picked ? { kind: 'board', id: picked.id } : { kind: 'none' });
    });
  }, [router]);

  if (state.kind === 'board') return <TVBoardView id={state.id} showBackButton />;

  if (state.kind === 'none') {
    return (
      <TVShell>
        <div style={{ textAlign: 'center', padding: 'clamp(60px, 12vh, 160px) 20px', fontFamily: "'DM Sans', sans-serif" }}>
          <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: '#E4B94B', margin: '0 0 14px' }}>TV Leaderboard</p>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 'clamp(28px, 4vw, 46px)', color: '#fff', margin: '0 0 14px' }}>Your live board goes here.</h1>
          <p style={{ fontSize: 'clamp(15px, 1.8vw, 20px)', color: '#9FBFA6', maxWidth: 540, margin: '0 auto 30px', lineHeight: 1.55 }}>
            Once you create a tournament, cast this page to a clubhouse TV — standings, pace of play, contest winners, and your live fundraising total update themselves as players score.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => router.push('/setup/format')} style={{ background: '#E4B94B', color: '#123', border: 'none', borderRadius: 10, padding: '13px 24px', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Create your first tournament</button>
            <button onClick={() => router.push('/dashboard')} style={{ background: 'transparent', color: '#CDE0D2', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, padding: '13px 22px', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Back to dashboard</button>
          </div>
        </div>
      </TVShell>
    );
  }

  return <TVShell><p style={{ color: '#9FBFA6', fontSize: 28, textAlign: 'center', marginTop: 120, fontFamily: "'DM Sans', sans-serif" }}>Loading leaderboard…</p></TVShell>;
}
