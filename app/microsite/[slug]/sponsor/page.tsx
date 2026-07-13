'use client';

import { supabase } from '@/lib/supabaseClient';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type Tournament = {
  id: string;
  name: string;
  event_date: string;
  microsite_color: string | null;
  contact_email: string | null;
  cause_org: string | null;
  location_name: string | null;
};

type Tier = {
  id: string;
  name: string;
  label: string | null;
  price_cents: number;
  benefits: string[];
  quantity: number | null;
  highlight: boolean;
  sold: number;
};

type PaymentSession = { sessionId: string; sessionData: string; clientKey: string };

function money(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export default function SponsorPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [selected, setSelected] = useState<Tier | null>(null);
  const [company, setCompany] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [paymentSession, setPaymentSession] = useState<PaymentSession | null>(null);
  const [done, setDone] = useState<'paid' | 'committed' | null>(null);
  const [paymentError, setPaymentError] = useState('');
  const dropinRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const { data: t } = await supabase
        .from('tournaments')
        .select('id, name, event_date, microsite_color, contact_email, cause_org, location_name')
        .eq('slug', slug)
        .in('status', ['published', 'live'])
        .single();
      if (!t) return;
      setTournament(t);
      const res = await fetch(`/api/sponsors/purchase?tournament_id=${t.id}`);
      if (res.ok) setTiers(await res.json());
    })();
  }, [slug]);

  const primaryColor = tournament?.microsite_color ?? '#1B6B3A';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !tournament) return;
    if (!company.trim() || !email.trim()) { setError('Company name and email are required.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/sponsors/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament_id: tournament.id,
          tier_id: selected.id,
          company: company.trim(),
          contact_name: contactName.trim() || null,
          email: email.trim(),
          phone: phone.trim() || null,
          website: website.trim() || null,
          return_url: `${window.location.origin}/microsite/${slug}/sponsor?complete=1`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      if (data.payment) {
        setPaymentSession(data.payment);
      } else {
        setDone('committed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  // Mount Adyen Drop-in when payment session is ready
  useEffect(() => {
    if (!paymentSession || !dropinRef.current || !selected) return;
    let dropin: { unmount: () => void } | null = null;

    (async () => {
      const { AdyenCheckout, Dropin, Card } = await import('@adyen/adyen-web');
      const checkout = await AdyenCheckout({
        session: { id: paymentSession.sessionId, sessionData: paymentSession.sessionData },
        environment: paymentSession.clientKey.startsWith('live_') ? 'live' : 'test',
        clientKey: paymentSession.clientKey,
        amount: { value: selected.price_cents, currency: 'USD' },
        locale: 'en-US',
        onPaymentCompleted: (result: { resultCode?: string }) => {
          if (result.resultCode === 'Authorised' || result.resultCode === 'Received') {
            setDone('paid');
          } else {
            setPaymentError(`Payment ${result.resultCode ?? 'failed'}. Please try again.`);
          }
        },
        onPaymentFailed: (result?: { resultCode?: string }) => {
          setPaymentError(`Payment ${result?.resultCode ?? 'failed'}. Please try a different card.`);
        },
        onError: (err: { message?: string }) => {
          console.error('Adyen error:', err);
          setPaymentError(err.message ?? 'Payment error. Please try again.');
        },
      });
      dropin = new Dropin(checkout, { paymentMethodComponents: [Card] }).mount(dropinRef.current!);
    })();

    return () => { dropin?.unmount(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentSession]);

  if (!tournament) return null;

  const dateStr = new Date(tournament.event_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', color: '#1A1F1C' },
    header: { background: primaryColor, padding: '48px 24px', textAlign: 'center', color: '#fff' },
    body: { maxWidth: 1080, margin: '0 auto', padding: '48px 24px' },
    label: { display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6, color: '#3A3F3C' },
    input: { width: '100%', padding: '10px 12px', border: '1px solid #E5E0D5', borderRadius: 4, fontSize: 15, background: '#fff', boxSizing: 'border-box' },
    btn: { width: '100%', padding: '14px', background: primaryColor, color: '#fff', fontWeight: 700, fontSize: 16, border: 'none', borderRadius: 4, cursor: 'pointer' },
  };

  if (done) {
    return (
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, margin: 0 }}>{tournament.name}</h1>
        </div>
        <div style={{ ...s.body, maxWidth: 560, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, marginBottom: 12 }}>Thank you, {company}!</h2>
          <p style={{ color: '#3A3F3C', lineHeight: 1.7, marginBottom: 8 }}>
            {done === 'paid'
              ? `Your ${selected?.name} sponsorship is confirmed and paid. The organizer will reach out shortly about your logo and signage.`
              : `Your ${selected?.name} sponsorship is reserved. The organizer will send an invoice and follow up about your logo and signage.`}
          </p>
          <p style={{ color: '#6B7775', fontSize: 14, marginBottom: 28 }}>A confirmation is on its way to {email}.</p>
          <Link href={`/microsite/${slug}`} style={{ color: primaryColor, fontWeight: 600 }}>← Back to the event page</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 34, margin: '0 0 8px' }}>Sponsor {tournament.name}</h1>
        <p style={{ color: 'rgba(255,255,255,0.8)', margin: 0, fontSize: 15 }}>
          {dateStr}{tournament.location_name ? ` · ${tournament.location_name}` : ''}{tournament.cause_org ? ` · Benefiting ${tournament.cause_org}` : ''}
        </p>
      </div>

      <div style={s.body}>
        {!selected ? (
          <>
            <p style={{ textAlign: 'center', color: '#3A3F3C', fontSize: 16, maxWidth: 620, margin: '0 auto 36px', lineHeight: 1.7 }}>
              Put your business in front of {tournament.cause_org ? 'a community that shows up for ' + tournament.cause_org : 'local golfers, business owners, and community leaders'} — and fund a great cause while you&rsquo;re at it.
            </p>
            {tiers.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#6B7775' }}>
                Sponsorship packages are coming soon. {tournament.contact_email && <>Contact <a href={`mailto:${tournament.contact_email}`} style={{ color: primaryColor }}>{tournament.contact_email}</a> to sponsor this event.</>}
              </p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 16 }}>
                {tiers.map(t => {
                  const soldOut = t.quantity != null && t.sold >= t.quantity;
                  return (
                    <div key={t.id} style={{
                      background: '#fff', borderRadius: 12, padding: '22px 20px', display: 'flex', flexDirection: 'column',
                      border: t.highlight ? '2px solid #C8A04A' : '1px solid #E5E0D5', opacity: soldOut ? 0.6 : 1,
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.highlight ? '#C8A04A' : '#6B7775', marginBottom: 8 }}>
                        {t.highlight ? '★ ' : ''}{t.label ?? t.name}
                      </div>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 21, fontWeight: 700, marginBottom: 2 }}>{t.name}</div>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, color: primaryColor, marginBottom: 14 }}>{money(t.price_cents)}</div>
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px', flex: 1 }}>
                        {t.benefits.map((b, i) => (
                          <li key={i} style={{ fontSize: 13.5, color: '#3A3F3C', padding: '3px 0', display: 'flex', gap: 7 }}>
                            <span style={{ color: primaryColor, fontWeight: 700 }}>✓</span>{b}
                          </li>
                        ))}
                      </ul>
                      {t.quantity != null && (
                        <p style={{ fontSize: 12.5, color: '#6B7775', margin: '0 0 12px' }}>
                          {soldOut ? 'Sold out' : `${t.quantity - t.sold} of ${t.quantity} remaining`}
                        </p>
                      )}
                      <button
                        disabled={soldOut}
                        onClick={() => { setSelected(t); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                        style={{ ...s.btn, padding: '11px', fontSize: 14.5, opacity: soldOut ? 0.5 : 1, cursor: soldOut ? 'default' : 'pointer' }}
                      >
                        {soldOut ? 'Sold out' : 'Sponsor this level'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <p style={{ textAlign: 'center', marginTop: 36 }}>
              <Link href={`/microsite/${slug}`} style={{ color: primaryColor, fontWeight: 600, fontSize: 14 }}>← Back to the event page</Link>
            </p>
          </>
        ) : paymentSession ? (
          <div style={{ maxWidth: 560, margin: '0 auto' }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, marginBottom: 6 }}>Complete your {selected.name}</h2>
            <p style={{ color: '#6B7775', fontSize: 14, marginBottom: 20 }}>{company} · {money(selected.price_cents)}</p>
            {paymentError && <p style={{ color: '#C0392B', fontSize: 14, marginBottom: 12 }}>{paymentError}</p>}
            <div ref={dropinRef} />
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ maxWidth: 560, margin: '0 auto' }}>
            <button type="button" onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: primaryColor, fontSize: 14, padding: 0, marginBottom: 16 }}>
              ← All packages
            </button>
            <div style={{ background: '#fff', border: `2px solid ${selected.highlight ? '#C8A04A' : primaryColor}`, borderRadius: 12, padding: '18px 20px', marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 700 }}>{selected.name}</div>
                <div style={{ fontSize: 13, color: '#6B7775', marginTop: 2 }}>{selected.benefits.slice(0, 2).join(' · ')}</div>
              </div>
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: primaryColor }}>{money(selected.price_cents)}</div>
            </div>

            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <label style={s.label}>Company name *</label>
                <input style={s.input} value={company} onChange={e => setCompany(e.target.value)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={s.label}>Contact name</label>
                  <input style={s.input} value={contactName} onChange={e => setContactName(e.target.value)} />
                </div>
                <div>
                  <label style={s.label}>Phone</label>
                  <input style={s.input} value={phone} onChange={e => setPhone(e.target.value)} />
                </div>
              </div>
              <div>
                <label style={s.label}>Email *</label>
                <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              <div>
                <label style={s.label}>Website (for your logo link)</label>
                <input style={s.input} value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://" />
              </div>
              {error && <p style={{ color: '#C0392B', fontSize: 14, margin: 0 }}>{error}</p>}
              <button type="submit" disabled={submitting} style={{ ...s.btn, opacity: submitting ? 0.7 : 1 }}>
                {submitting ? 'One moment…' : `Continue to payment — ${money(selected.price_cents)}`}
              </button>
              <p style={{ textAlign: 'center', fontSize: 12, color: '#6B7775', margin: 0 }}>
                Secure payment · Your logo and recognition are coordinated by the organizer after purchase.
              </p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
