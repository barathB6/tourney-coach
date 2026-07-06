'use client';

import { useEffect, useState, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';
import '@adyen/adyen-web/styles/adyen.css';

interface Tournament {
  id: string;
  name: string;
  event_date: string;
  format: string;
  max_players: number;
  entry_fee_cents: number | null;
  cause_story: string | null;
}

interface Player { name: string; email: string; }

const REG_TYPES = [
  { id: 'foursome', label: 'Foursome — Scramble Team', desc: 'Four players · cart · lunch · range balls · gift bag · contests included', price: 600, unit: '/team', playerCount: 4 },
  { id: 'single',   label: 'Single Player',             desc: "We'll match you with three others. Same inclusions.",                       price: 165, unit: '/player', playerCount: 1 },
  { id: 'sponsor',  label: 'Title Sponsor + Foursome',  desc: 'Top-line logo placement, banner at 1st tee, 4 players, premium gifts',    price: 5000, unit: '', playerCount: 4 },
];

const SOURCES = [
  { value: 'tourneycircle',   label: 'TourneyCircle' },
  { value: 'word_of_mouth',   label: 'Word of mouth' },
  { value: 'golf_pro_referral', label: 'Pro shop referral' },
  { value: 'social',          label: 'Social media' },
  { value: 'google',          label: 'Google search' },
  { value: 'other',           label: 'Other' },
];

const ADD_ONS = [
  { id: 'mulligans', label: 'Mulligans (2 per player)', price: 80 },
  { id: 'putting',   label: 'Putting contest add',       price: 40 },
];

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();
}
function fmtMoney(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function emptyPlayers(n: number): Player[] {
  return Array.from({ length: n }, () => ({ name: '', email: '' }));
}

function RegisterInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tournamentId = searchParams?.get('id');

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [registrationCount, setRegistrationCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ foursomeNumber: number; startingHole: number | null; regId: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Payment step state
  const [paymentSession, setPaymentSession] = useState<{ sessionId: string; sessionData: string; clientKey: string } | null>(null);
  const [pendingReg, setPendingReg] = useState<{ id: string; foursomeNumber: number; startingHole: number | null } | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const dropinRef = useRef<HTMLDivElement>(null);

  // Form state
  const [selectedType, setSelectedType] = useState('foursome');
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [teamName, setTeamName] = useState('');
  // Singles: play solo (we pair you) or join an existing team with open spots
  const [teamMode, setTeamMode] = useState<'solo' | 'join'>('solo');
  const [openTeams, setOpenTeams] = useState<{ team_name: string; spots_left: number }[]>([]);
  const [joinTeam, setJoinTeam] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [players, setPlayers] = useState<Player[]>(emptyPlayers(4));

  const regType = REG_TYPES.find(r => r.id === selectedType) ?? REG_TYPES[0];

  // Keep players array sized to selected type
  useEffect(() => {
    setPlayers(prev => {
      const n = regType.playerCount;
      if (prev.length === n) return prev;
      return prev.length > n ? prev.slice(0, n) : [...prev, ...emptyPlayers(n - prev.length)];
    });
  }, [selectedType, regType.playerCount]);

  // Load open teams for the "join existing team" option
  useEffect(() => {
    if (!tournamentId || selectedType !== 'single') return;
    fetch(`/api/tournaments/${tournamentId}/teams`)
      .then(r => r.json())
      .then(d => setOpenTeams(d.teams ?? []))
      .catch(() => setOpenTeams([]));
  }, [tournamentId, selectedType]);

  useEffect(() => {
    async function load() {
      if (!tournamentId) { setLoading(false); return; }
      const [{ data: t }, { count }] = await Promise.all([
        supabase.from('tournaments').select('id, name, event_date, format, max_players, entry_fee_cents, cause_story').eq('id', tournamentId).single(),
        supabase.from('registrations').select('*', { count: 'exact', head: true }).eq('tournament_id', tournamentId).in('payment_status', ['pending', 'paid']),
      ]);
      if (t) setTournament(t);
      setRegistrationCount(count ?? 0);
      setLoading(false);
    }
    load();
  }, [tournamentId]);

  const addOnTotal = ADD_ONS.filter(a => selectedAddOns.includes(a.id)).reduce((s, a) => s + a.price, 0);
  const total = regType.price + addOnTotal;
  const spotsTotal = tournament?.max_players ?? 96;
  const foursomesTotal = Math.floor(spotsTotal / 4);
  const foursomesFilled = registrationCount;
  const spotsUsed = registrationCount * regType.playerCount;
  const spotsRemaining = spotsTotal - spotsUsed;

  function updatePlayer(i: number, field: keyof Player, value: string) {
    setPlayers(prev => prev.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!contactName.trim() || !contactEmail.trim()) {
      setSubmitError('Contact name and email are required.');
      return;
    }
    const filledPlayers = players.filter(p => p.name.trim());
    if (filledPlayers.length !== regType.playerCount) {
      setSubmitError(`Please fill in all ${regType.playerCount} player name(s).`);
      return;
    }
    if (selectedType === 'single' && teamMode === 'join' && !joinTeam) {
      setSubmitError('Pick a team to join, or switch to playing solo.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament_id: tournamentId,
          registration_type: selectedType,
          team_name: selectedType === 'single'
            ? (teamMode === 'join' ? joinTeam : null)
            : (teamName.trim() || null),
          contact_name: contactName.trim(),
          contact_email: contactEmail.trim(),
          contact_phone: contactPhone.trim() || null,
          players: players.map(p => ({ name: p.name.trim(), email: p.email.trim() })),
          add_ons: selectedAddOns,
          registration_source: source || 'direct',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      // Create payment session and move to payment step
      const intentRes = await fetch('/api/payments/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration_id: data.id,
          return_url: `${window.location.origin}/register?id=${tournamentId}&payment_complete=1`,
        }),
      });
      const session = await intentRes.json();
      if (!intentRes.ok) throw new Error(session.error || 'Failed to start payment');

      setPendingReg({ id: data.id, foursomeNumber: data.foursome_number, startingHole: data.starting_hole });
      setPaymentSession(session);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  // Mount Adyen Drop-in when payment session is ready
  useEffect(() => {
    if (!paymentSession || !dropinRef.current) return;
    let dropin: { unmount: () => void } | null = null;

    (async () => {
      const { AdyenCheckout, Dropin, Card } = await import('@adyen/adyen-web');
      const checkout = await AdyenCheckout({
        session: { id: paymentSession.sessionId, sessionData: paymentSession.sessionData },
        environment: paymentSession.clientKey.startsWith('live_') ? 'live' : 'test',
        clientKey: paymentSession.clientKey,
        amount: { value: total * 100, currency: 'USD' },
        locale: 'en-US',
        onPaymentCompleted: (result: { resultCode?: string }) => {
          if (result.resultCode === 'Authorised' || result.resultCode === 'Received') {
            setSubmitted({ foursomeNumber: pendingReg!.foursomeNumber, startingHole: pendingReg!.startingHole, regId: pendingReg!.id });
          } else {
            setPaymentError(`Payment ${result.resultCode ?? 'failed'}. Please try again.`);
          }
        },
        onPaymentFailed: (result?: { resultCode?: string }) => {
          setPaymentError(`Payment ${result?.resultCode ?? 'failed'}. Please try a different card.`);
        },
        onError: (error: { message?: string }) => {
          console.error('Adyen error:', error);
          setPaymentError(error.message ?? 'Payment error. Please try again.');
        },
      });
      dropin = new Dropin(checkout, { paymentMethodComponents: [Card] }).mount(dropinRef.current!);
    })();

    return () => { dropin?.unmount(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentSession]);

  // ── Styles ──────────────────────────────────────────────────────────────────
  const s: Record<string, React.CSSProperties> = {
    page: { minHeight: '100vh', background: 'var(--cream)', fontFamily: "'DM Sans', system-ui, sans-serif", WebkitFontSmoothing: 'antialiased' },
    hero: { background: 'var(--deep-green)', padding: '32px 0 36px', color: '#fff' },
    heroWrap: { maxWidth: 1080, margin: '0 auto', padding: '0 24px' },
    dateBadge: { display: 'inline-block', background: 'var(--gold)', color: '#2a1800', fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, padding: '5px 12px', borderRadius: 6, marginBottom: 14 },
    heroName: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 38, lineHeight: 1.15, margin: '0 0 10px', letterSpacing: '-.02em' },
    heroMeta: { fontSize: 14, color: 'rgba(250,248,243,.72)', lineHeight: 1.6 },
    publicBadge: { display: 'inline-block', border: '1px solid rgba(255,255,255,.3)', color: 'rgba(255,255,255,.8)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, padding: '3px 9px', borderRadius: 4, marginBottom: 10 },
    body: { maxWidth: 1080, margin: '32px auto', padding: '0 24px 60px', display: 'grid', gridTemplateColumns: '1fr 360px', gap: 28, alignItems: 'start' },
    sectionH: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 18, color: 'var(--ink)', margin: '0 0 14px', letterSpacing: '-.01em' },
    blockH: { fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, color: '#5C6B62', margin: '0 0 10px' },
    typeCard: { border: '1px solid var(--line)', borderRadius: 12, padding: '16px 18px', background: '#fff', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 10 },
    typeCardActive: { border: '2px solid var(--primary)', borderRadius: 12, padding: '15px 17px', background: '#fff', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 10 },
    typeLabel: { fontWeight: 700, fontSize: 15, color: 'var(--ink)', marginBottom: 3 },
    typeDesc: { fontSize: 12.5, color: '#5C6B62', lineHeight: 1.4 },
    typePrice: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 22, color: 'var(--primary)', whiteSpace: 'nowrap' as const, textAlign: 'right' as const },
    typeUnit: { fontSize: 12, color: '#5C6B62', fontWeight: 400 },
    // Form inputs
    formSection: { background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: '20px 22px', marginTop: 22 },
    label: { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginBottom: 5 },
    input: { width: '100%', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 14, fontFamily: "'DM Sans', sans-serif", color: 'var(--ink)', background: '#fff', outline: 'none', boxSizing: 'border-box' as const },
    twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
    playerRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 },
    playerNum: { fontSize: 11, fontWeight: 700, color: '#5C6B62', letterSpacing: '.05em', textTransform: 'uppercase' as const, marginBottom: 6 },
    sourceGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 4 },
    sourceBtn: { border: '1px solid var(--line)', borderRadius: 8, padding: '9px 10px', background: '#fff', fontSize: 13, color: 'var(--ink)', cursor: 'pointer', textAlign: 'center' as const, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 },
    sourceBtnActive: { border: '1px solid var(--primary)', borderRadius: 8, padding: '9px 10px', background: '#EAF2ED', fontSize: 13, color: 'var(--primary)', cursor: 'pointer', textAlign: 'center' as const, fontFamily: "'DM Sans', sans-serif", fontWeight: 600 },
    lineRowOpt: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#5C6B62', padding: '6px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' },
    // Card
    card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: '20px', boxShadow: '0 1px 3px rgba(15,74,38,.06), 0 6px 20px rgba(15,74,38,.08)', position: 'sticky' as const, top: 24 },
    cardH: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: 'var(--ink)', margin: '0 0 16px' },
    lineRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5, color: 'var(--ink)', padding: '6px 0', borderBottom: '1px solid var(--line)' },
    totalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 0 0', marginTop: 4 },
    impact: { background: '#FDF8EC', border: '1px solid #E8D9A0', borderRadius: 10, padding: '12px 14px', marginTop: 14, fontSize: 13, color: '#5C4A00', lineHeight: 1.5 },
    ctaBtn: { width: '100%', marginTop: 16, padding: '14px', background: 'var(--deep-green)', color: '#fff', border: 'none', borderRadius: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 15, cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1 },
    secured: { textAlign: 'center' as const, fontSize: 10.5, color: '#5C6B62', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, marginTop: 10 },
    errorBox: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#B91C1C', marginTop: 12 },
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--ink)', fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Loading…</p>
      </div>
    );
  }

  // ── Success state ──────────────────────────────────────────────────────────
  if (submitted) {
    return (
      <div style={s.page}>
        <header style={s.hero}>
          <div style={s.heroWrap}>
            <span style={s.publicBadge}>Public</span>
            <h1 style={s.heroName} className="regHeroName">{tournament?.name ?? 'Charity Golf Tournament'}</h1>
          </div>
        </header>
        <div style={{ maxWidth: 560, margin: '60px auto', padding: '0 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⛳</div>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 28, color: 'var(--deep-green)', margin: '0 0 10px' }}>You&rsquo;re in!</h2>
          <p style={{ fontSize: 15, color: '#5C6B62', lineHeight: 1.6, margin: '0 0 24px' }}>
            Registration confirmed for <strong style={{ color: 'var(--ink)' }}>{contactName}</strong>.
            {submitted.foursomeNumber && (
              <> You&rsquo;re <strong>Foursome #{submitted.foursomeNumber}</strong>
                {submitted.startingHole && <>, starting on <strong>Hole {submitted.startingHole}</strong></>}.
              </>
            )}
          </p>
          <p style={{ fontSize: 13.5, color: '#5C6B62', marginBottom: 32 }}>
            A confirmation email is on its way to <strong>{contactEmail}</strong> with tournament details, parking info, and your hole assignment.
          </p>
          <div style={{ background: '#EAF2ED', border: '1px solid #C8DDD1', borderRadius: 12, padding: '16px 20px', fontSize: 13.5, color: '#2c4537', marginBottom: 24, lineHeight: 1.6 }}>
            <strong>Payment received.</strong> Your spot is confirmed — see you on the course!
          </div>

          <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: '20px 24px', marginBottom: 24, display: 'inline-block' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(`${typeof window !== 'undefined' ? window.location.origin : ''}/checkin/${submitted.regId}`)}`}
              width={160}
              height={160}
              alt="Check-in QR code"
              style={{ display: 'block', margin: '0 auto' }}
            />
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#5C6B62', margin: '12px 0 0', textAlign: 'center' }}>
              Show this at check-in
            </p>
          </div>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 24px', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const heroDate = tournament?.event_date ? fmtDate(tournament.event_date) : 'DATE TBD';

  // ── Payment step ──────────────────────────────────────────────────────────
  if (paymentSession) {
    return (
      <div style={s.page}>
        <header style={s.hero}>
          <div style={s.heroWrap}>
            <span style={s.publicBadge}>Public</span>
            <h1 style={s.heroName} className="regHeroName">{tournament?.name ?? 'Charity Golf Tournament'}</h1>
          </div>
        </header>
        <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 24px 60px' }}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 24, color: 'var(--ink)', margin: '0 0 6px' }}>Complete your payment</h2>
          <p style={{ fontSize: 14, color: '#5C6B62', margin: '0 0 24px' }}>
            {regType.label.split('—')[0].trim()} · <strong style={{ color: 'var(--ink)' }}>{fmtMoney(total)}</strong>
            {teamName && <> · Team {teamName}</>}
          </p>
          {paymentError && (
            <div style={{ ...s.errorBox, marginBottom: 16 }}>{paymentError}</div>
          )}
          <div ref={dropinRef} />
          <p style={{ ...s.secured, marginTop: 16 }}>Secure payment powered by Adyen</p>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <style>{`
        @media (max-width: 860px) {
          .regBody { grid-template-columns: 1fr !important; }
          .regSummaryCard { position: static !important; }
        }
        @media (max-width: 560px) {
          .regTwoCol, .regPlayerRow, .regSourceGrid { grid-template-columns: 1fr !important; }
          .regHeroName { font-size: 30px !important; }
        }
      `}</style>

      {/* ── Hero ── */}
      <header style={s.hero}>
        <div style={s.heroWrap}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={s.publicBadge}>Public</div>
              <div style={s.dateBadge}>{heroDate}</div>
              <h1 style={s.heroName} className="regHeroName">{tournament?.name ?? 'Charity Golf Tournament'}</h1>
              <p style={s.heroMeta}>
                {spotsRemaining} / {spotsTotal} spots remaining
              </p>
            </div>
            <button onClick={() => router.back()} style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", marginTop: 4 }}>
              ← Back
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <form onSubmit={handleSubmit}>
        <div style={s.body} className="regBody">

          {/* Left column */}
          <div>

            {/* Registration type */}
            <h2 style={s.sectionH}>Choose how you want to play</h2>
            {REG_TYPES.map((rt) => {
              const active = selectedType === rt.id;
              return (
                <div key={rt.id} style={active ? s.typeCardActive : s.typeCard} onClick={() => setSelectedType(rt.id)}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, marginTop: 2, border: active ? '5px solid var(--primary)' : '2px solid var(--line)', background: '#fff', display: 'inline-block' }} />
                    <div>
                      <div style={s.typeLabel}>{rt.label}</div>
                      <div style={s.typeDesc}>{rt.desc}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={s.typePrice}>
                      {rt.price >= 1000 ? `$${rt.price.toLocaleString()}` : `$${rt.price}`}
                      {rt.unit && <span style={s.typeUnit}>{rt.unit}</span>}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* ── Player & contact form ── */}
            <div style={s.formSection}>
              <h2 style={{ ...s.sectionH, margin: '0 0 18px' }}>
                {selectedType === 'single' ? 'Your details' : 'Team details'}
              </h2>

              {/* Team name (foursome / sponsor only) */}
              {selectedType !== 'single' && (
                <div style={{ marginBottom: 16 }}>
                  <label style={s.label}>Team name</label>
                  <input style={s.input} placeholder="e.g., The Mulligan Masters" value={teamName} onChange={e => setTeamName(e.target.value)} />
                </div>
              )}

              {/* Singles: solo vs join existing team */}
              {selectedType === 'single' && (
                <div style={{ marginBottom: 20 }}>
                  <p style={{ ...s.blockH, marginBottom: 10 }}>Team assignment</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, color: 'var(--ink)' }}>
                      <input type="radio" name="teamMode" checked={teamMode === 'solo'} onChange={() => setTeamMode('solo')} style={{ accentColor: 'var(--primary)' }} />
                      Play solo — we&rsquo;ll pair you with a group
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: openTeams.length ? 'pointer' : 'not-allowed', fontSize: 14, color: openTeams.length ? 'var(--ink)' : '#9BA8A4' }}>
                      <input type="radio" name="teamMode" disabled={!openTeams.length} checked={teamMode === 'join'} onChange={() => setTeamMode('join')} style={{ accentColor: 'var(--primary)' }} />
                      Join an existing team{!openTeams.length && ' (no open teams yet)'}
                    </label>
                  </div>
                  {teamMode === 'join' && openTeams.length > 0 && (
                    <select
                      value={joinTeam}
                      onChange={e => setJoinTeam(e.target.value)}
                      style={{ ...s.input, marginTop: 10, cursor: 'pointer' }}
                    >
                      <option value="">Choose a team…</option>
                      {openTeams.map(t => (
                        <option key={t.team_name} value={t.team_name}>
                          {t.team_name} — {t.spots_left} spot{t.spots_left !== 1 ? 's' : ''} left
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Contact info */}
              <p style={{ ...s.blockH, marginBottom: 12 }}>Primary contact</p>
              <div style={{ ...s.twoCol, marginBottom: 12 }} className="regTwoCol">
                <div>
                  <label style={s.label}>Full name *</label>
                  <input style={s.input} placeholder="Jane Smith" value={contactName} onChange={e => setContactName(e.target.value)} required />
                </div>
                <div>
                  <label style={s.label}>Email *</label>
                  <input style={s.input} type="email" placeholder="jane@example.com" value={contactEmail} onChange={e => setContactEmail(e.target.value)} required />
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={s.label}>Phone (for day-of updates)</label>
                <input style={{ ...s.input, maxWidth: 260 }} type="tel" placeholder="(555) 000-0000" value={contactPhone} onChange={e => setContactPhone(e.target.value)} />
              </div>

              {/* Player slots */}
              <p style={{ ...s.blockH, marginBottom: 12 }}>
                {selectedType === 'single' ? 'Your info' : `Players (${regType.playerCount})`}
              </p>
              {players.map((p, i) => (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div style={s.playerNum}>Player {i + 1}{i === 0 ? ' (you)' : ''}</div>
                  <div style={s.playerRow} className="regPlayerRow">
                    <input
                      style={s.input}
                      placeholder="Full name"
                      value={p.name}
                      onChange={e => updatePlayer(i, 'name', e.target.value)}
                    />
                    <input
                      style={s.input}
                      type="email"
                      placeholder="Email"
                      value={p.email}
                      onChange={e => updatePlayer(i, 'email', e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Add-ons */}
            <div style={{ marginTop: 22, marginBottom: 22 }}>
              <p style={s.blockH}>Optional add-ons</p>
              {ADD_ONS.map((addon) => {
                const on = selectedAddOns.includes(addon.id);
                return (
                  <div key={addon.id} style={s.lineRowOpt} onClick={() => setSelectedAddOns(prev => on ? prev.filter(x => x !== addon.id) : [...prev, addon.id])}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 16, height: 16, borderRadius: 4, border: on ? 'none' : '1.5px solid var(--line)', background: on ? 'var(--primary)' : '#fff', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                        {on && <svg width="10" height="10" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>}
                      </span>
                      {addon.label} — <span style={{ fontSize: 12, color: '#8A9E90' }}>opt</span>
                    </span>
                    <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{fmtMoney(addon.price)}</span>
                  </div>
                );
              })}
            </div>

            {/* Source tracking */}
            <h2 style={s.sectionH}>How did you hear about us?</h2>
            <div style={s.sourceGrid} className="regSourceGrid">
              {SOURCES.map((src) => (
                <button type="button" key={src.value} style={source === src.value ? s.sourceBtnActive : s.sourceBtn} onClick={() => setSource(src.value)}>
                  {src.label}{source === src.value ? ' ✓' : ''}
                </button>
              ))}
            </div>

          </div>

          {/* Right column — summary */}
          <div>
            <div style={s.card} className="regSummaryCard">
              <h3 style={s.cardH}>Your registration</h3>

              <div style={s.lineRow}>
                <span>{regType.label.split('—')[0].trim()} entry</span>
                <span style={{ fontWeight: 600 }}>{fmtMoney(regType.price)}</span>
              </div>
              {ADD_ONS.map(a => (
                <div key={a.id} style={s.lineRowOpt} onClick={() => setSelectedAddOns(prev => prev.includes(a.id) ? prev.filter(x => x !== a.id) : [...prev, a.id])}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, border: selectedAddOns.includes(a.id) ? 'none' : '1.5px solid var(--line)', background: selectedAddOns.includes(a.id) ? 'var(--primary)' : '#fff', display: 'grid', placeItems: 'center' }}>
                      {selectedAddOns.includes(a.id) && <svg width="9" height="9" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>}
                    </span>
                    {a.label} — opt
                  </span>
                  <span>{fmtMoney(a.price)}</span>
                </div>
              ))}

              <div style={s.totalRow}>
                <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>Total</span>
                <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 22, color: 'var(--ink)' }}>{fmtMoney(total)}</span>
              </div>

              <div style={s.impact}>
                <strong>Your impact:</strong> roughly{' '}
                <strong style={{ color: '#7A4A00' }}>
                  {Math.max(1, Math.floor(total / 340))} student{Math.floor(total / 340) !== 1 ? 's' : ''}
                </strong>{' '}
                will have their tuition gap covered by your team&rsquo;s registration. Thank you.
              </div>

              {submitError && <div style={s.errorBox}>{submitError}</div>}

              <button type="submit" style={s.ctaBtn} disabled={submitting}>
                {submitting ? 'Submitting…' : `Continue to payment — ${fmtMoney(total)}`}
              </button>
              <p style={s.secured}>Secure payment powered by Adyen</p>
            </div>
          </div>

        </div>
      </form>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ fontFamily: "'DM Sans', sans-serif", color: 'var(--ink)', fontSize: 14 }}>Loading…</p>
      </div>
    }>
      <RegisterInner />
    </Suspense>
  );
}
