'use client';

import { useEffect, useState } from 'react';

// Renders as a static number on first paint (SSR value), then polls for
// updates so the "N of M foursomes claimed" stat stays live while a visitor
// is on the page — without needing a full realtime subscription.
export default function LiveSpotsStat({
  tournamentId,
  initialCount,
  foursomesTotal,
}: {
  tournamentId: string;
  initialCount: number;
  foursomesTotal: number;
}) {
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch(`/api/tournaments/${tournamentId}/progress`, { cache: 'no-store' })
        .then(r => r.json())
        .then(d => { if (!cancelled && typeof d.count === 'number') setCount(d.count); })
        .catch(() => { /* keep last known value on error */ });
    };
    const interval = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tournamentId]);

  return (
    <>
      <p style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: '0 0 4px', color: '#fff' }}>
        {Math.floor(count)} / {foursomesTotal}
      </p>
      <p style={{ fontSize: 12, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
        foursomes claimed
      </p>
    </>
  );
}
