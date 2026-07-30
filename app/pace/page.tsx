'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';

type TeamPace = {
  registrationId: string;
  teamName: string;
  holesCompleted: number;
  currentHole: number | null;
  positionSource: 'gps' | 'scores' | null;
  holesRemaining: number;
  minutesPerHole: number | null;
  minutesToFinish: number | null;
  estimatedFinish: string | null;
  status: 'not_started' | 'playing' | 'finished';
  pace: 'green' | 'yellow' | 'red' | null;
  minutesSinceLastHole: number | null;
};
type PaceData = {
  tournamentName: string;
  totalHoles: number;
  teams: TeamPace[];
  playing: number;
  finished: number;
  notStarted: number;
  fieldMaxThru: number;
  lastFinishIso: string | null;
  minutesUntilLastFinish: number | null;
  holesInPlay: number[];
  kitchen: { sentAt: string; toPhone: string; message: string; status: string } | null;
  kitchenPhone: string | null;
  kitchenReady: boolean;
};

const PACE_COLOR: Record<string, string> = { green: '#1B6B3A', yellow: '#C8A04A', red: '#B8442C' };
const PACE_BG: Record<string, string> = { green: '#E7F1EA', yellow: '#FBF0DC', red: '#FBE9E7' };
const PACE_LABEL: Record<string, string> = { green: 'On pace', yellow: 'Slightly behind', red: 'Needs attention' };

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';
const mins = (m: number | null) => (m == null ? '—' : `${Math.round(m)} min`);

export default function PacePage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [data, setData] = useState<PaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (tid: string) => {
    const res = await authedFetch(`/api/tournament/${tid}/pace`);
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setData(d as PaceData); setError(''); }
    else setError(d.error || 'Could not load pace');
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/pace'); return; }
      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const { data: all } = await supabase.from('tournaments').select('id, name')
        .eq('organizer_id', user.id).order('created_at', { ascending: false });
      const list = all ?? [];
      const t = list.find((x) => x.id === selectedId) ?? list[0] ?? null;
      if (!t) { setLoading(false); return; }
      setTournamentId(t.id);
      await load(t.id);
      setLoading(false);
    });
  }, [router, load]);

  // Live during a round — the estimate moves as holes come in.
  useEffect(() => {
    if (!tournamentId) return;
    const poll = setInterval(() => load(tournamentId), 30_000);
    return () => clearInterval(poll);
  }, [tournamentId, load]);

  const onCourse = data?.teams.filter((t) => t.status === 'playing') ?? [];
  const needsAttention = onCourse.filter((t) => t.pace === 'red');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '26px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

        <div style={{ margin: '14px 0 22px' }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 38, lineHeight: 1.05, color: 'var(--ink)', margin: '0 0 10px' }}>Pace of Play</h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.5, color: '#5C6B62', maxWidth: 640, margin: 0 }}>
            Where every group is right now, and when the last one gets in. The kitchen is texted automatically 45 minutes before that — you don&apos;t have to watch this screen.
          </p>
        </div>

        {loading ? (
          <p style={{ color: '#8A9089' }}>Loading…</p>
        ) : !tournamentId ? (
          <div style={S.card}><p style={{ margin: 0, color: '#6B7775' }}>Set up your event first.</p></div>
        ) : error ? (
          <div style={{ ...S.card, borderColor: '#F5C6C0' }}><p style={{ margin: 0, color: 'var(--alert)' }}>{error}</p></div>
        ) : !data ? null : (
          <>
            {/* Field summary */}
            <div className="tc-quick" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 18 }}>
              <Stat label="On the course" value={String(data.playing)} sub={data.holesInPlay.length ? `holes ${data.holesInPlay.join(', ')}` : 'no groups out'} />
              <Stat label="Finished" value={String(data.finished)} sub={data.notStarted ? `${data.notStarted} not started` : 'everyone teed off'} />
              <Stat label="Last group in" value={clock(data.lastFinishIso)} sub={data.minutesUntilLastFinish != null ? `about ${Math.round(data.minutesUntilLastFinish)} min away` : 'no estimate yet'} />
              <Stat label="Needs attention" value={String(needsAttention.length)} sub={needsAttention.length ? 'contact these groups' : 'field is moving well'} accent={needsAttention.length ? 'var(--alert)' : undefined} />
            </div>

            {/* Kitchen */}
            <div style={{ ...S.card, marginBottom: 18, background: data.kitchen ? '#E7F1EA' : '#fff', borderColor: data.kitchen ? '#B7E0C6' : 'var(--line)' }}>
              <div style={S.kick}>Kitchen notification</div>
              {data.kitchen ? (
                <>
                  <p style={{ margin: '6px 0 4px', fontSize: 15, fontWeight: 700, color: 'var(--deep-green)' }}>
                    Sent at {clock(data.kitchen.sentAt)} to {data.kitchen.toPhone}
                  </p>
                  <p style={{ margin: 0, fontSize: 13.5, color: '#4A524C', fontStyle: 'italic' }}>&ldquo;{data.kitchen.message}&rdquo;</p>
                </>
              ) : data.kitchenReady ? (
                <p style={{ margin: '6px 0 0', fontSize: 13.5, color: '#5C6B62', lineHeight: 1.55 }}>
                  Armed. We&apos;ll text {data.kitchenPhone} automatically when the last group is 45 minutes out — no action needed from you.
                </p>
              ) : (
                <p style={{ margin: '6px 0 0', fontSize: 13.5, color: '#8A6D1F', lineHeight: 1.55 }}>
                  {data.kitchenPhone
                    ? 'Text messaging isn’t configured on this deployment yet, so the kitchen won’t be texted automatically. You’ll still see the timing here.'
                    : 'No usable phone number on the course profile — add the pro shop’s number under Course Builder and the kitchen text arms itself.'}
                </p>
              )}
            </div>

            {/* Groups */}
            {data.teams.length === 0 ? (
              <div style={S.card}><p style={{ margin: 0, color: '#6B7775' }}>No teams registered yet.</p></div>
            ) : (
              <div className="tc-scroll-x" style={{ ...S.card, padding: 0, overflow: 'hidden' }}>
                <table style={{ width: '100%', minWidth: 680, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)', background: '#FAF8F3' }}>
                      {['Group', 'Thru', 'On hole', 'Pace', 'Per hole', 'Est. finish'].map((h) => (
                        <th key={h} style={S.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.teams]
                      .sort((a, b) => (b.minutesToFinish ?? -1) - (a.minutesToFinish ?? -1))
                      .map((t, i, arr) => (
                        <tr key={t.registrationId} style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none' }}>
                          <td style={{ ...S.td, fontWeight: 600 }}>{t.teamName}</td>
                          <td style={S.td}>{t.holesCompleted} / {data.totalHoles}</td>
                          <td style={S.td}>
                            {t.status === 'finished' ? <span style={{ color: '#6B7775' }}>in</span>
                              : t.currentHole ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  Hole {t.currentHole}
                                  {/* Live GPS vs inferred from the scorecard — an
                                      organizer chasing a slow group should know
                                      whether this is where they ARE or where
                                      their card says they should be. */}
                                  <span
                                    title={t.positionSource === 'gps' ? 'Live GPS position' : 'Inferred from holes posted — no live GPS'}
                                    style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: t.positionSource === 'gps' ? 'var(--primary)' : '#9BA8A4' }}
                                  >
                                    {t.positionSource === 'gps' ? 'GPS' : 'est'}
                                  </span>
                                </span>
                              )
                              : <span style={{ color: '#9BA8A4' }}>not started</span>}
                          </td>
                          <td style={S.td}>
                            {t.pace ? (
                              <span style={{ background: PACE_BG[t.pace], color: PACE_COLOR[t.pace], borderRadius: 999, padding: '3px 10px', fontSize: 12.5, fontWeight: 700 }}>
                                {PACE_LABEL[t.pace]}
                              </span>
                            ) : <span style={{ color: '#9BA8A4' }}>—</span>}
                          </td>
                          <td style={S.td}>{mins(t.minutesPerHole)}</td>
                          <td style={{ ...S.td, fontWeight: 600 }}>
                            {t.status === 'finished' ? clock(t.estimatedFinish) : t.estimatedFinish ? `${clock(t.estimatedFinish)} (${mins(t.minutesToFinish)})` : '—'}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            <p style={{ fontSize: 12, color: '#8A9089', margin: '10px 2px 0', lineHeight: 1.55 }}>
              Estimates come from each group&apos;s own scoring pace, so they sharpen after three holes. Pace colour is relative to the front of the field. Updates every 30 seconds.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return (
    <div style={S.card}>
      <div style={S.kick}>{label}</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 30, fontWeight: 700, color: accent ?? 'var(--ink)', margin: '4px 0 2px' }}>{value}</div>
      <div style={{ fontSize: 12.5, color: '#8A9089' }}>{sub}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 20 },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' },
  th: { padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775' },
  td: { padding: '13px 16px', fontSize: 14 },
};
