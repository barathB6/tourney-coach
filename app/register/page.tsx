'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';

interface Tournament {
  id: string;
  name: string;
  event_date: string;
  format: string;
  max_players: number;
  entry_fee: number | null;
  cause_story: string | null;
}

const REG_TYPES = [
  {
    id: 'foursome',
    label: 'Foursome — Scramble Team',
    desc: 'Four players · cart · lunch · range balls · gift bag · contests included',
    price: 600,
    unit: '/team',
  },
  {
    id: 'single',
    label: 'Single Player',
    desc: "We'll match you with three others. Same inclusions.",
    price: 165,
    unit: '/player',
  },
  {
    id: 'sponsor',
    label: 'Title Sponsor + Foursome',
    desc: 'Top-line logo placement, banner at 1st tee, 4 players, premium gifts',
    price: 5000,
    unit: '',
  },
];

const SOURCES = [
  { value: 'tourneycircle', label: 'TourneyCircle' },
  { value: 'word_of_mouth', label: 'Word of mouth' },
  { value: 'golf_pro_referral', label: 'Pro shop referral' },
  { value: 'social', label: 'Social media' },
  { value: 'google', label: 'Google search' },
  { value: 'other', label: 'Other' },
];

const ADD_ONS = [
  { id: 'mulligans', label: 'Mulligans (2 per player)', price: 80 },
  { id: 'putting', label: 'Putting contest add', price: 40 },
];

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).toUpperCase();
}

function fmtMoney(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function RegisterInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tournamentId = searchParams?.get('id');

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedType, setSelectedType] = useState('foursome');
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([]);
  const [source, setSource] = useState('');

  useEffect(() => {
    async function load() {
      if (!tournamentId) { setLoading(false); return; }
      const { data } = await supabase
        .from('tournaments')
        .select('id, name, event_date, format, max_players, entry_fee, cause_story')
        .eq('id', tournamentId)
        .single();
      if (data) setTournament(data);
      setLoading(false);
    }
    load();
  }, [tournamentId]);

  const regType = REG_TYPES.find(r => r.id === selectedType) ?? REG_TYPES[0];
  const addOnTotal = ADD_ONS.filter(a => selectedAddOns.includes(a.id)).reduce((s, a) => s + a.price, 0);
  const total = regType.price + addOnTotal;
  const spotsRemaining = tournament ? tournament.max_players : 96;
  const spotsUsed = 0; // TODO: replace with real registration count

  const s: Record<string, React.CSSProperties> = {
    page: { minHeight: '100vh', background: 'var(--cream)', fontFamily: "'DM Sans', system-ui, sans-serif", WebkitFontSmoothing: 'antialiased' },

    // Header
    hero: { background: 'var(--deep-green)', padding: '32px 0 36px', color: '#fff' },
    heroWrap: { maxWidth: 1080, margin: '0 auto', padding: '0 24px' },
    dateBadge: { display: 'inline-block', background: 'var(--gold)', color: '#2a1800', fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, padding: '5px 12px', borderRadius: 6, marginBottom: 14 },
    heroName: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 38, lineHeight: 1.15, margin: '0 0 10px', letterSpacing: '-.02em' },
    heroMeta: { fontSize: 14, color: 'rgba(250,248,243,.72)', lineHeight: 1.6 },
    publicBadge: { display: 'inline-block', border: '1px solid rgba(255,255,255,.3)', color: 'rgba(255,255,255,.8)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, padding: '3px 9px', borderRadius: 4, marginBottom: 10 },

    // Body
    body: { maxWidth: 1080, margin: '32px auto', padding: '0 24px 60px', display: 'grid', gridTemplateColumns: '1fr 360px', gap: 28, alignItems: 'start' },

    sectionH: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 18, color: 'var(--ink)', margin: '0 0 14px', letterSpacing: '-.01em' },
    blockH: { fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, color: '#5C6B62', margin: '0 0 10px' },

    // Registration type cards
    typeCard: { border: '1px solid var(--line)', borderRadius: 12, padding: '16px 18px', background: '#fff', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 10, transition: 'border-color .15s' },
    typeCardActive: { border: '2px solid var(--primary)', borderRadius: 12, padding: '15px 17px', background: '#fff', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 10 },
    typeLabel: { fontWeight: 700, fontSize: 15, color: 'var(--ink)', marginBottom: 3 },
    typeDesc: { fontSize: 12.5, color: '#5C6B62', lineHeight: 1.4 },
    typePrice: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 22, color: 'var(--primary)', whiteSpace: 'nowrap' as const, textAlign: 'right' as const },
    typeUnit: { fontSize: 12, color: '#5C6B62', fontWeight: 400 },

    // Source grid
    sourceGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 4 },
    sourceBtn: { border: '1px solid var(--line)', borderRadius: 8, padding: '9px 10px', background: '#fff', fontSize: 13, color: 'var(--ink)', cursor: 'pointer', textAlign: 'center' as const, fontFamily: "'DM Sans', sans-serif", fontWeight: 500 },
    sourceBtnActive: { border: '1px solid var(--primary)', borderRadius: 8, padding: '9px 10px', background: '#EAF2ED', fontSize: 13, color: 'var(--primary)', cursor: 'pointer', textAlign: 'center' as const, fontFamily: "'DM Sans', sans-serif", fontWeight: 600 },

    // Summary card
    card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: '20px', boxShadow: '0 1px 3px rgba(15,74,38,.06), 0 6px 20px rgba(15,74,38,.08)', position: 'sticky' as const, top: 24 },
    cardH: { fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: 'var(--ink)', margin: '0 0 16px' },
    lineRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5, color: 'var(--ink)', padding: '6px 0', borderBottom: '1px solid var(--line)' },
    lineRowOpt: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#5C6B62', padding: '6px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' },
    totalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 0 0', marginTop: 4 },
    totalLabel: { fontWeight: 700, fontSize: 15, color: 'var(--ink)' },
    totalAmt: { fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 22, color: 'var(--ink)' },

    // Impact box
    impact: { background: '#FDF8EC', border: '1px solid #E8D9A0', borderRadius: 10, padding: '12px 14px', marginTop: 14, fontSize: 13, color: '#5C4A00', lineHeight: 1.5 },

    // CTA
    ctaBtn: { width: '100%', marginTop: 16, padding: '14px', background: 'var(--deep-green)', color: '#fff', border: 'none', borderRadius: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 15, cursor: 'pointer', letterSpacing: '.01em' },
    secured: { textAlign: 'center' as const, fontSize: 10.5, color: '#5C6B62', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, marginTop: 10 },

    // Placeholder notice
    payPlaceholder: { background: '#FFF8F0', border: '1px dashed #D9A96B', borderRadius: 10, padding: '12px 14px', marginTop: 12, fontSize: 12, color: '#7A4A00', lineHeight: 1.5 },

    // Notes section
    notesWrap: { maxWidth: 1080, margin: '0 auto', padding: '0 24px 56px' },
    notesH: { fontSize: 10.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, color: '#5C6B62', margin: '0 0 14px' },
    notesGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 },
    noteCard: { background: '#fff', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 18px' },
    noteTag: { fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' as const, color: '#5C6B62', marginBottom: 8 },
    noteTitle: { fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', marginBottom: 6, fontFamily: "'DM Sans', sans-serif" },
    noteBody: { fontSize: 12.5, color: '#5C6B62', lineHeight: 1.55 },
    noteCode: { display: 'inline-block', background: '#EAF2ED', color: 'var(--primary)', fontFamily: 'monospace', fontSize: 11.5, padding: '1px 6px', borderRadius: 4 },
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--cream)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--ink)', fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Loading…</p>
      </div>
    );
  }

  const heroName = tournament?.name ?? 'Charity Golf Tournament';
  const heroDate = tournament?.event_date ? fmtDate(tournament.event_date) : 'DATE TBD';
  const foursomes = Math.floor(spotsRemaining / 4);
  const foursomesUsed = Math.floor(spotsUsed / 4);

  return (
    <div style={s.page}>

      {/* ── Hero header ── */}
      <header style={s.hero}>
        <div style={s.heroWrap}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={s.publicBadge}>Public</div>
              <div style={s.dateBadge}>{heroDate}</div>
              <h1 style={s.heroName}>{heroName}</h1>
              <p style={s.heroMeta}>
                {tournament
                  ? `${spotsRemaining - spotsUsed} / ${spotsRemaining} spots remaining`
                  : '96 / 96 spots remaining'
                }
              </p>
            </div>
            <button
              onClick={() => router.back()}
              style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", marginTop: 4 }}
            >
              ← Back to dashboard
            </button>
          </div>
        </div>
      </header>

      {/* ── Two-column body ── */}
      <div style={s.body}>

        {/* Left column */}
        <div>
          <h2 style={s.sectionH}>Choose how you want to play</h2>

          {REG_TYPES.map((rt) => {
            const active = selectedType === rt.id;
            return (
              <div
                key={rt.id}
                style={active ? s.typeCardActive : s.typeCard}
                onClick={() => setSelectedType(rt.id)}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                    border: active ? '5px solid var(--primary)' : '2px solid var(--line)',
                    background: '#fff', display: 'inline-block',
                  }} />
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

          {/* Add-ons */}
          <div style={{ marginTop: 24, marginBottom: 28 }}>
            <p style={s.blockH}>Optional add-ons</p>
            {ADD_ONS.map((addon) => {
              const on = selectedAddOns.includes(addon.id);
              return (
                <div
                  key={addon.id}
                  style={{ ...s.lineRowOpt, cursor: 'pointer', userSelect: 'none' as const }}
                  onClick={() => setSelectedAddOns(prev =>
                    on ? prev.filter(x => x !== addon.id) : [...prev, addon.id]
                  )}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: 4, border: on ? 'none' : '1.5px solid var(--line)',
                      background: on ? 'var(--primary)' : '#fff', display: 'grid', placeItems: 'center', flexShrink: 0,
                    }}>
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
          <div style={s.sourceGrid}>
            {SOURCES.map((src) => (
              <button
                key={src.value}
                style={source === src.value ? s.sourceBtnActive : s.sourceBtn}
                onClick={() => setSource(src.value)}
              >
                {src.label}{source === src.value ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>

        {/* Right column — order summary */}
        <div>
          <div style={s.card}>
            <h3 style={s.cardH}>Your registration</h3>

            <div style={s.lineRow}>
              <span>{regType.label.split('—')[0].trim()} entry</span>
              <span style={{ fontWeight: 600 }}>{fmtMoney(regType.price)}</span>
            </div>
            {ADD_ONS.map(a => (
              <div
                key={a.id}
                style={{ ...s.lineRowOpt }}
                onClick={() => setSelectedAddOns(prev =>
                  prev.includes(a.id) ? prev.filter(x => x !== a.id) : [...prev, a.id]
                )}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    border: selectedAddOns.includes(a.id) ? 'none' : '1.5px solid var(--line)',
                    background: selectedAddOns.includes(a.id) ? 'var(--primary)' : '#fff',
                    display: 'grid', placeItems: 'center',
                  }}>
                    {selectedAddOns.includes(a.id) && <svg width="9" height="9" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>}
                  </span>
                  {a.label} — opt
                </span>
                <span>{fmtMoney(a.price)}</span>
              </div>
            ))}

            <div style={s.totalRow}>
              <span style={s.totalLabel}>Total</span>
              <span style={s.totalAmt}>{fmtMoney(total)}</span>
            </div>

            {/* Impact framing */}
            <div style={s.impact}>
              <strong>Your impact:</strong> roughly{' '}
              <strong style={{ color: '#7A4A00' }}>
                {Math.max(1, Math.floor(total / 340))} student{Math.floor(total / 340) !== 1 ? 's' : ''}
              </strong>{' '}
              will have their tuition gap covered by your team&rsquo;s registration. Thank you.
            </div>

            {/* PAYMENT SDK GOES HERE — processor TBD */}
            <button style={s.ctaBtn} onClick={() => alert('Payment processor not yet integrated.')}>
              Continue to payment
            </button>
            <p style={s.secured}>Secured by Adyen · 100% to the cause</p>
          </div>
        </div>
      </div>


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
