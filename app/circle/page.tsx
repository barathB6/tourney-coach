'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';
import { RADIUS_OPTIONS, dollars, NOTIFICATION_COST_CENTS, PREVIEW_RADIUS_COUNTS, previewBreakdown } from '@/lib/tourneycircle';

type Matched = { total: number; individual: number; corporate: number; coe: number };
type Disclosed = { value: number; suppressed: boolean };
type CircleData = {
  courseLocated: boolean;
  radiusMiles: number;
  matched: Matched;
  matchedSuppressed: boolean;
  byRadius: ({ radiusMiles: number } & Disclosed)[];
  byCause: ({ cause: string } & Disclosed)[];
  typeBreakdownPartial?: boolean;
  minDisclosableCount: number;
  expectedClicks: number;
  costCents: number;
  history: { radiusMiles: number; reached: number; clicked: number; registered: number; sentAt: string }[];
};

export default function CirclePage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [courseName, setCourseName] = useState<string>('your course');
  const [radius, setRadius] = useState<number>(25);
  const [data, setData] = useState<CircleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async (tid: string, r: number) => {
    const res = await authedFetch(`/api/tournament/${tid}/circle?radius=${r}`);
    const d = await res.json().catch(() => ({}));
    if (res.ok) setData(d as CircleData);
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/circle'); return; }

      // Match the tournament the organizer has open on the dashboard, not just
      // their newest — same key every other tournament-scoped page reads.
      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const { data: all } = await supabase.from('tournaments').select('id, name, course_id').eq('organizer_id', user.id).order('created_at', { ascending: false });
      const list = all ?? [];
      const t = list.find((x) => x.id === selectedId) ?? list[0] ?? null;
      if (!t) { setLoading(false); return; }
      setTournamentId(t.id);
      if (t.course_id) {
        const { data: c } = await supabase.from('courses').select('name').eq('id', t.course_id).maybeSingle();
        if (c?.name) setCourseName(c.name);
      } else if (t.name) setCourseName(t.name);
      await load(t.id, 25);
      setLoading(false);
    });
  }, [router, load]);

  const onRadius = (r: number) => { setRadius(r); setNote(''); if (tournamentId) load(tournamentId, r); };

  const send = async () => {
    if (!tournamentId || sending) return;
    if (preview) {
      setNote(`Notification queued — TourneyCoach will deliver it to ~${total} matched players on your behalf. Clicks and registrations appear here as they come in.`);
      return;
    }
    if (!confirm(`Send one notification to ${total} matched player${total === 1 ? '' : 's'} within ${radius} miles for $29? TourneyCoach delivers it on your behalf — you never see who they are.`)) return;
    setSending(true); setNote('');
    const res = await authedFetch(`/api/tournament/${tournamentId}/circle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ radiusMiles: radius }),
    });
    const d = await res.json().catch(() => ({}));
    setSending(false);
    if (!res.ok) { setNote(d.error || 'Could not send'); return; }
    setNote(`Notification queued — TourneyCoach is delivering it to ${d.reached} matched player${d.reached === 1 ? '' : 's'} on your behalf.`);
    load(tournamentId, radius);
  };

  // Real opt-in count when the course has any; otherwise the addressable-reach
  // estimate (ported from the original TourneyCircle) so the page shows the
  // "you have an audience already" pitch before opt-ins accumulate.
  const realTotal = data?.matched.total ?? 0;
  // A suppressed count is a real (but too-small) audience, not an empty one —
  // so it must NOT fall through to the marketing preview numbers, which would
  // replace "we're withholding this" with an invented 347.
  const suppressed = !!data?.matchedSuppressed;
  const preview = realTotal === 0 && !suppressed;
  const total = preview ? (PREVIEW_RADIUS_COUNTS[radius] ?? 0) : realTotal;
  const bd = preview ? previewBreakdown(total) : data!.matched;
  const clicks = preview ? Math.floor(total * 0.25) : (data?.expectedClicks ?? 0);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--cream)' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '26px 20px 64px' }}>
        <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

        <div style={{ margin: '14px 0 22px' }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 38, lineHeight: 1.05, color: 'var(--ink)', margin: '0 0 10px' }}>TourneyCircle Discovery &amp; Opt-in</h1>
          <p style={{ fontSize: 15.5, lineHeight: 1.5, color: '#5C6B62', maxWidth: 640, margin: 0 }}>
            The “you have an audience already” moment. Your course and date reveal how many opted-in charitable golfers live within reach — privacy-protected: TourneyCoach sees the players, you see only the count.
          </p>
        </div>

        {loading ? (
          <p style={{ color: '#8A9089' }}>Loading…</p>
        ) : !tournamentId ? (
          <div style={S.card}><p style={{ margin: 0, color: '#6B7775' }}>Set up your event first — then TourneyCircle can show your reach.</p></div>
        ) : (
          <>
            {/* Hero */}
            <div style={S.hero}>
              <div style={{ position: 'relative', zIndex: 1, maxWidth: 620 }}>
                <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 34, color: '#fff', margin: '0 0 14px' }}>
                  You&apos;re not starting <span style={{ color: 'var(--gold)', fontStyle: 'italic' }}>cold.</span>
                </h2>
                {total > 0 ? (
                  <p style={S.heroP}>There are {total} charitable golfer{total === 1 ? '' : 's'} within {radius} miles of {courseName} who told us they want to hear about tournaments like yours. Send one notification. Watch what happens.</p>
                ) : suppressed ? (
                  <p style={S.heroP}>
                    Your reach here is still too small to report. TourneyCircle shows a count only once at least {data?.minDisclosableCount ?? 5} golfers match — below that, a number would describe individual people rather than an audience. It grows every time a player opts in at the end of their round.
                  </p>
                ) : (
                  <p style={S.heroP}>
                    {data?.courseLocated
                      ? `No opted-in golfers within ${radius} miles yet. Your reach grows every time a player opts in at the end of their round — the network compounds tournament over tournament.`
                      : `Your course location resolves from live GPS once you host a round here. After that, TourneyCircle shows exactly how many opted-in golfers are within reach.`}
                  </p>
                )}
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 72, fontWeight: 700, color: 'var(--gold)', lineHeight: 1, marginTop: 18 }}>{suppressed ? '—' : total}</div>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', marginTop: 6 }}>Matched players within {radius} miles</div>
                {total > 0 && (
                  <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', marginTop: 8 }}>
                    {bd.individual} individual · {bd.corporate} corporate · {bd.coe} Circle of Excellence
                    {/* Each of those three runs the same disclosure ladder as the
                        total, so a split like "5 individual · 1 corporate" — one
                        identifiable company — is withheld rather than printed.
                        Saying so keeps a withheld bucket from reading as a zero. */}
                    {data?.typeBreakdownPartial && (
                      <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)', marginTop: 4 }}>
                        A category showing 0 here is too small to report, not necessarily empty — the split follows the same {data?.minDisclosableCount ?? 5}-player floor as the total.
                      </div>
                    )}
                  </div>
                )}
              </div>
              <Radar />
            </div>

            {/* Controls */}
            <div style={{ ...S.card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr)) auto', gap: 24, alignItems: 'end', marginTop: 18 }}>
              <div>
                <div style={S.kick}>Reach radius</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: '2px 0 10px' }}>{radius} miles</div>
                <input
                  type="range" min={0} max={RADIUS_OPTIONS.length - 1} step={1}
                  value={Math.max(0, (RADIUS_OPTIONS as readonly number[]).indexOf(radius))}
                  onChange={(e) => onRadius(RADIUS_OPTIONS[Number(e.target.value)])}
                  style={{ width: '100%', accentColor: 'var(--primary)', height: 4 }}
                  aria-label="Reach radius"
                />
              </div>
              <div>
                <div style={S.kick}>Notification cost</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: '2px 0 4px' }}>{dollars(data?.costCents ?? NOTIFICATION_COST_CENTS)} flat</div>
                <div style={{ fontSize: 12, color: '#8A9089' }}>One notification — sent to all {total} matched player{total === 1 ? '' : 's'}</div>
              </div>
              <div>
                <div style={S.kick}>Expected click-through</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: '2px 0 4px' }}>~{clicks} will click</div>
                <div style={{ fontSize: 12, color: '#8A9089' }}>About 1 in 4 players click through, based on past tournaments</div>
              </div>
              <button onClick={send} disabled={sending || total === 0} style={{ ...S.sendBtn, opacity: sending || total === 0 ? 0.5 : 1 }}>
                {sending ? 'Sending…' : 'Send notification'}
              </button>
            </div>
            {note && <p style={{ fontSize: 13, color: note.startsWith('Notification queued') ? 'var(--primary)' : 'var(--alert)', margin: '10px 2px 0' }}>{note}</p>}

            {/* Aggregate breakdowns — Day 25. Counts only, and every bucket
                below the disclosure threshold is withheld rather than shown,
                so no combination of views isolates an individual. */}
            {!preview && data && (
              <div className="tc-two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 18 }}>
                <div style={S.card}>
                  <div style={S.kick}>Matched players by radius</div>
                  <div style={{ marginTop: 12 }}>
                    {data.byRadius.map((r) => {
                      const max = Math.max(1, ...data.byRadius.map((x) => x.value));
                      return (
                        <div key={r.radiusMiles} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, width: 54, color: r.radiusMiles === radius ? 'var(--primary)' : '#6B7775' }}>{r.radiusMiles} mi</span>
                          <div style={{ flex: 1, height: 8, background: '#F1ECDD', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ width: `${(r.value / max) * 100}%`, height: '100%', background: r.radiusMiles === radius ? 'var(--primary)' : '#B7D3C0', borderRadius: 4 }} />
                          </div>
                          <span style={{ fontSize: 13.5, fontWeight: 700, width: 58, textAlign: 'right', color: r.suppressed ? '#9AA39D' : 'var(--ink)' }}>
                            {r.suppressed ? '—' : r.value}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div style={S.card}>
                  <div style={S.kick}>By cause preference · within {radius} mi</div>
                  {data.byCause.length > 0 ? (
                    <div style={{ marginTop: 12 }}>
                      {data.byCause.map((c) => (
                        <div key={c.cause} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
                          <span style={{ color: '#4A524C', textTransform: 'capitalize' }}>{c.cause}</span>
                          <span style={{ fontWeight: 700 }}>{c.value}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: 13, color: '#8A9089', margin: '12px 0 0', lineHeight: 1.55 }}>
                      No cause group in this radius is large enough to report yet. Groups appear once at least {data.minDisclosableCount} players share a cause.
                    </p>
                  )}
                </div>
              </div>
            )}

            {!preview && data && (
              <p style={{ fontSize: 12, color: '#8A9089', margin: '10px 2px 0', lineHeight: 1.55 }}>
                Any group smaller than {data.minDisclosableCount} players is shown as “—” on purpose. A count that small would describe a person rather than an audience.
              </p>
            )}

            {/* How it works */}
            <div style={{ ...S.card, background: '#F3EFE4', marginTop: 18 }}>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: '#4A524C', margin: 0 }}>
                <strong style={{ color: 'var(--ink)' }}>How it works.</strong> When you send a notification, TourneyCoach delivers it on your behalf. Players see a branded email with your event details and a registration link. <strong style={{ color: 'var(--ink)' }}>You never see player names or emails</strong> — only the aggregate count of who was reached, who clicked, and who registered. Privacy is the trust mechanism that keeps players opted in, year after year.
              </p>
            </div>

            {/* History */}
            {data && data.history.length > 0 && (
              <div style={{ ...S.card, marginTop: 18 }}>
                <div style={S.kick}>Notifications sent</div>
                <div style={{ marginTop: 8 }}>
                  {data.history.map((h, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: i < data.history.length - 1 ? '1px solid var(--line)' : 'none', fontSize: 13.5 }}>
                      <span style={{ color: '#6B7775' }}>{new Date(h.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {h.radiusMiles} mi</span>
                      <span style={{ color: 'var(--ink)' }}>{h.reached} reached · {h.clicked} clicked · {h.registered} registered</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Radar() {
  return (
    <svg viewBox="0 0 300 260" width="300" height="260" style={{ position: 'absolute', right: 28, top: 28, opacity: 0.9, maxWidth: '40%' }} aria-hidden>
      {[130, 95, 60, 30].map((r) => <circle key={r} cx="200" cy="130" r={r} fill="none" stroke="rgba(201,162,39,0.28)" strokeWidth="1" />)}
      {[[250, 90], [235, 165], [200, 195], [165, 120], [205, 130]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="4.5" fill="var(--gold)" opacity="0.9" />
      ))}
    </svg>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 22 },
  hero: { position: 'relative', overflow: 'hidden', background: 'linear-gradient(135deg, #0F4A26, #17632F)', borderRadius: 20, padding: '34px 34px 30px' },
  heroP: { fontSize: 15, lineHeight: 1.55, color: 'rgba(255,255,255,0.85)', margin: 0 },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089' },
  radiusBtn: { minWidth: 40, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: '#fff', color: 'var(--ink)', fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  radiusOn: { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' },
  sendBtn: { background: 'var(--gold)', color: '#2E1F04', border: 'none', borderRadius: 10, padding: '13px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: "'DM Sans', sans-serif" },
};
