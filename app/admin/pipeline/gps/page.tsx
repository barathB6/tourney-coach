'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Coverage = 'verified' | 'building' | 'pending';

type CourseRow = {
  name: string;
  location: string;
  tournaments: number;
  teeGreen: Coverage;
  fairway: Coverage;
  hazard: Coverage;
};

type Stats = {
  activeRounds: number;
  activeCourses: number;
  coordsToday: number;
  coordsYesterday: number;
  totalTracks: number;
  totalDevices: number;
  activeConsentDevices: number;
  verifiedCourses: number;
  avgGreenAccuracyM: number | null;
  lastIngestAt: string | null;
  perCourse: CourseRow[];
};

function fmt(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

const BADGE: Record<Coverage, { label: string; bg: string; fg: string }> = {
  verified: { label: 'Verified', bg: '#E4F0E8', fg: '#1B6B3A' },
  building: { label: 'Building', bg: '#E4ECF5', fg: '#2563AA' },
  pending: { label: 'Pending', bg: '#F0EDE4', fg: '#8A8172' },
};

function Badge({ c }: { c: Coverage }) {
  const b = BADGE[c];
  return (
    <span style={{ display: 'inline-block', background: b.bg, color: b.fg, fontSize: 12.5, fontWeight: 600, padding: '4px 12px', borderRadius: 20 }}>
      {b.label}
    </span>
  );
}

// The pipeline architecture, exactly as designed. Labels reflect what the
// system actually does (15s logging interval; Supabase Postgres) rather than
// aspirational figures.
const FLOW: ({ icon: string; label: string; sub: string } | 'arrow')[] = [
  { icon: '📱', label: 'Player phones', sub: 'Coords every 15s' },
  'arrow',
  { icon: '🎯', label: 'Score event', sub: 'Coord = green' },
  'arrow',
  { icon: '☁️', label: 'Supabase', sub: 'Tagged tracks' },
  { icon: '🧮', label: 'Cluster engine', sub: 'Statistical avg' },
  'arrow',
  { icon: '🗺️', label: 'Course profile', sub: 'Patent moat' },
];

export default function GpsPipelinePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { router.replace('/sign-in?next=/admin/pipeline/gps'); return; }

      let res = await fetch('/api/gps/admin/stats', { headers: { Authorization: `Bearer ${session.access_token}` } });

      // A cached access token can outlive its server-side session (e.g. after
      // signing in elsewhere) — the token isn't expired but auth.getUser
      // rejects the dead session with 401. Try one refresh, then send the
      // user to re-authenticate rather than dead-ending on a load error.
      if (res.status === 401) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        if (refreshed.session) {
          res = await fetch('/api/gps/admin/stats', { headers: { Authorization: `Bearer ${refreshed.session.access_token}` } });
        }
        if (res.status === 401) {
          // The session is dead server-side. Clear the stale local session
          // FIRST — otherwise /sign-in sees the cached token via getSession(),
          // bounces back here, and we loop. signOut local-only (a server
          // signOut would 403 on the already-dead session).
          await supabase.auth.signOut({ scope: 'local' });
          router.replace('/sign-in?next=/admin/pipeline/gps');
          return;
        }
      }

      if (res.status === 403) { setForbidden(true); setLoading(false); return; }
      if (!res.ok) { setLoading(false); return; }
      setStats(await res.json());
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#F4F1EA', minHeight: '100vh', padding: '28px 24px 60px', color: '#1A1F1C' },
    wrap: { maxWidth: 1120, margin: '0 auto' },
    card: { background: '#fff', border: '1px solid #E7E2D6', borderRadius: 16, padding: 28 },
    node: { background: '#F7F5F0', border: '1px solid #EAE5D9', borderRadius: 12, padding: '20px 16px', width: 150, textAlign: 'center' },
    statLabel: { fontSize: 11.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#8A8F88', margin: '0 0 10px' },
    statVal: { fontFamily: "'Fraunces', serif", fontSize: 40, fontWeight: 700, lineHeight: 1, margin: '0 0 8px', color: '#1A1F1C' },
    statSub: { fontSize: 13, color: '#1B6B3A', margin: 0 },
  };

  if (loading) return <div style={s.page}><p style={{ color: '#8A8F88' }}>Loading…</p></div>;

  if (forbidden) {
    return (
      <div style={s.page}>
        <div style={{ ...s.wrap, maxWidth: 620 }}>
          <p style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, marginBottom: 10 }}>Admin access required</p>
          <p style={{ fontSize: 13.5, color: '#6B7775', lineHeight: 1.6 }}>
            This page is gated to accounts with <code>role = &apos;admin&apos;</code> on their <code>profiles</code> row.
          </p>
        </div>
      </div>
    );
  }

  if (!stats) return <div style={s.page}><p style={{ color: '#B91C1C' }}>Failed to load GPS pipeline stats.</p></div>;

  const accuracy = stats.avgGreenAccuracyM != null ? `±${stats.avgGreenAccuracyM}m` : '—';

  const statCards: { label: string; value: string; sub: string }[] = [
    { label: 'Active rounds now', value: `${stats.activeRounds}`, sub: `across ${stats.activeCourses} course${stats.activeCourses === 1 ? '' : 's'}` },
    { label: 'Coords today', value: fmt(stats.coordsToday), sub: stats.coordsYesterday > 0 ? `+${fmt(stats.coordsYesterday)} yesterday` : 'none yesterday' },
    { label: 'Courses w/ verified data', value: `${stats.verifiedCourses}`, sub: `of ${stats.perCourse.length} in the pipeline` },
    { label: 'Avg green accuracy', value: accuracy, sub: stats.avgGreenAccuracyM != null ? 'from consented phones' : 'no greens mapped yet' },
  ];

  return (
    <div style={s.page}>
      <div style={s.wrap}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: '#1B6B3A', background: '#E4F0E8', padding: '5px 11px', borderRadius: 6 }}>INTERNAL</span>
        </div>

        {/* Header + pipeline flow */}
        <div style={{ ...s.card, marginBottom: 22 }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 27, fontWeight: 700, margin: '0 0 8px' }}>Crowdsourced collection — pipeline status</h1>
          <p style={{ fontSize: 14, color: '#8A8F88', margin: '0 0 26px', lineHeight: 1.5 }}>
            Architecture per the provisional patent filing. Collection is consent-gated and runs with no manual surveying.
            {stats.lastIngestAt
              ? ` Last point received ${new Date(stats.lastIngestAt).toLocaleString('en-US')}.`
              : ' No GPS points received yet — every figure below is a live query.'}
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
            {FLOW.map((n, i) =>
              n === 'arrow' ? (
                <span key={i} style={{ color: '#1B6B3A', fontSize: 20 }}>→</span>
              ) : (
                <div key={i} style={s.node}>
                  <div style={{ fontSize: 26, marginBottom: 10 }}>{n.icon}</div>
                  <p style={{ fontSize: 14, fontWeight: 700, margin: '0 0 3px' }}>{n.label}</p>
                  <p style={{ fontSize: 12, color: '#8A8F88', margin: 0 }}>{n.sub}</p>
                </div>
              )
            )}
          </div>
        </div>

        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 18, marginBottom: 22 }}>
          {statCards.map((c) => (
            <div key={c.label} style={s.card}>
              <p style={s.statLabel}>{c.label}</p>
              <p style={s.statVal}>{c.value}</p>
              <p style={s.statSub}>{c.sub}</p>
            </div>
          ))}
        </div>

        {/* Per-course coverage */}
        <div style={{ ...s.card, padding: 0 }}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, margin: 0, padding: '24px 28px 18px' }}>Per-course coverage status</h2>
          {stats.perCourse.length === 0 ? (
            <p style={{ fontSize: 13.5, color: '#8A8F88', padding: '0 28px 26px' }}>No course has recorded GPS activity yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    {['Course', 'Tournaments', 'Tee/green', 'Fairway', 'Hazards'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#8A8F88', padding: '10px 28px', borderTop: '1px solid #EDE8DC' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.perCourse.map((c, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #EDE8DC' }}>
                      <td style={{ padding: '18px 28px' }}>
                        <span style={{ fontWeight: 700, fontSize: 14.5 }}>{c.name}</span>
                        {c.location && <span style={{ color: '#8A8F88', fontSize: 14 }}> — {c.location}</span>}
                      </td>
                      <td style={{ padding: '18px 28px', fontSize: 14.5 }}>{c.tournaments}</td>
                      <td style={{ padding: '18px 28px' }}><Badge c={c.teeGreen} /></td>
                      <td style={{ padding: '18px 28px' }}><Badge c={c.fairway} /></td>
                      <td style={{ padding: '18px 28px' }}><Badge c={c.hazard} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p style={{ fontSize: 11.5, color: '#A7A99F', marginTop: 18 }}>
          Tee-cluster detection runs daily via cron. Fairway and hazard mapping activate automatically once enough rounds accumulate.
        </p>
      </div>
    </div>
  );
}
