'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Stats = {
  totalTracks: number;
  totalDevices: number;
  activeConsentDevices: number;
  registrationsWithConsent: number;
  tracksLast24h: number;
  lastIngestAt: string | null;
  holesWithTeeDetected: number;
  holesWithGreenDetected: number;
  totalHolesTracked: number;
  derivedFeaturesByType: Record<string, number>;
  byCourse: { name: string; totalHoles: number; teeDetected: number; greenDetected: number }[];
};

export default function GpsAdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { router.replace('/sign-in?next=/admin/pipeline/gps'); return; }

      const res = await fetch('/api/gps/admin/stats', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.status === 403) { setForbidden(true); setLoading(false); return; }
      if (!res.ok) { setLoading(false); return; }
      setStats(await res.json());
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 20px', color: '#1A1F1C' },
    wrap: { maxWidth: 760, margin: '0 auto' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 18 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 },
    statVal: { fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: '0 0 2px' },
    statLabel: { fontSize: 12, color: '#6B7775', margin: 0 },
  };

  if (loading) return <div style={s.page}><p style={{ color: '#6B7775' }}>Loading…</p></div>;

  if (forbidden) {
    return (
      <div style={s.page}>
        <div style={s.wrap}>
          <p style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, marginBottom: 10 }}>Admin access required</p>
          <p style={{ fontSize: 13.5, color: '#6B7775', lineHeight: 1.6 }}>
            This page is gated to accounts with <code>role = &apos;admin&apos;</code> on their <code>profiles</code> row. Your account doesn&rsquo;t have that yet — set it in the Supabase SQL editor:
          </p>
          <pre style={{ background: '#fff', border: '1px solid #E5E0D5', borderRadius: 10, padding: 14, fontSize: 12.5, overflowX: 'auto' }}>
{`update profiles set role = 'admin' where id = '<your-user-id>';`}
          </pre>
        </div>
      </div>
    );
  }

  if (!stats) return <div style={s.page}><p style={{ color: '#B91C1C' }}>Failed to load GPS pipeline stats.</p></div>;

  const totalDerived = Object.values(stats.derivedFeaturesByType ?? {}).reduce((a, b) => a + b, 0);
  const cards: [string, number | string][] = [
    ['GPS points ingested (all time)', stats.totalTracks],
    ['GPS points, last 24h', stats.tracksLast24h],
    ['Devices ever consented', stats.totalDevices],
    ['Devices actively tracking now', stats.activeConsentDevices],
    ['Registrations with active consent', stats.registrationsWithConsent],
    ['Holes with tee location detected', `${stats.holesWithTeeDetected} / ${stats.totalHolesTracked}`],
    ['Holes with green location detected', `${stats.holesWithGreenDetected} / ${stats.totalHolesTracked}`],
    ['Course features derived (all types)', totalDerived],
  ];

  return (
    <div style={s.page}>
      <div style={s.wrap}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 4px' }}>Internal</p>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, margin: '0 0 4px' }}>GPS Mapping Pipeline</h1>
        <p style={{ fontSize: 13, color: '#6B7775', margin: '0 0 24px' }}>
          {stats.lastIngestAt ? `Last point received ${new Date(stats.lastIngestAt).toLocaleString('en-US')}` : 'No GPS points received yet.'} Every number below is a live query, not a projection.
        </p>

        <div style={s.grid}>
          {cards.map(([label, val]) => (
            <div key={label} style={s.card}>
              <p style={s.statVal}>{val}</p>
              <p style={s.statLabel}>{label}</p>
            </div>
          ))}
        </div>

        <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px' }}>By course</p>
        {stats.byCourse.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6B7775' }}>No course has recorded GPS activity yet.</p>
        ) : (
          <div style={{ ...s.card, padding: 0, overflow: 'hidden' }}>
            {stats.byCourse.map((c, i) => (
              <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', borderTop: i === 0 ? 'none' : '1px solid #E5E0D5', fontSize: 13.5 }}>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                <span style={{ color: '#6B7775' }}>{c.teeDetected} tees · {c.greenDetected} greens mapped of {c.totalHoles} holes</span>
              </div>
            ))}
          </div>
        )}

        <p style={{ fontSize: 11.5, color: '#9AA39D', marginTop: 20 }}>Tee-cluster detection runs automatically once daily via cron.</p>
      </div>
    </div>
  );
}
