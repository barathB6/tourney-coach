'use client';

import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Registration = {
  id: string;
  registration_type: string;
  team_name: string | null;
  contact_name: string;
  contact_email: string;
  total_amount_cents: number;
  payment_status: string;
  foursome_number: number | null;
  starting_hole: number | null;
  created_at: string;
};

const TYPE_LABELS: Record<string, string> = {
  foursome: 'Foursome',
  single: 'Single',
  sponsor: 'Sponsor',
};

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  paid: { bg: '#EAF2ED', color: '#1B6B3A', label: 'Paid' },
  pending: { bg: '#FDF8EC', color: '#8A6D00', label: 'Pending' },
  failed: { bg: '#FEF2F2', color: '#B91C1C', label: 'Failed' },
  refunded: { bg: '#EFF1F0', color: '#5C6B62', label: 'Refunded' },
};

function fmtMoney(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

type TournamentOption = { id: string; name: string };

export default function RegistrationsPage() {
  const router = useRouter();
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (!user) { router.replace('/sign-in'); return; }

      const { data } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false });

      const list = data ?? [];
      setTournaments(list);
      if (list.length > 0) setSelectedTournament(list[0].id);
      else setLoading(false);
    });
  }, [router]);

  useEffect(() => {
    if (!selectedTournament) return;
    setLoading(true);
    supabase
      .from('registrations')
      .select('id, registration_type, team_name, contact_name, contact_email, total_amount_cents, payment_status, foursome_number, starting_hole, created_at')
      .eq('tournament_id', selectedTournament)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setRegistrations(data ?? []);
        setLoading(false);
      });
  }, [selectedTournament]);

  async function handleRefund(reg: Registration) {
    if (!window.confirm(`Refund ${fmtMoney(reg.total_amount_cents)} to ${reg.contact_name}? This cannot be undone.`)) return;

    setRefunding(reg.id);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in');

      const res = await fetch('/api/payments/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ registration_id: reg.id, reason: 'Organizer-initiated refund' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refund failed');

      // Optimistically show refund in progress; webhook flips status to refunded
      setRegistrations(prev => prev.map(r => r.id === reg.id ? { ...r, payment_status: 'refunded' } : r));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setRefunding(null);
    }
  }

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 8, overflow: 'hidden' },
  };

  if (loading) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  const paidTotal = registrations.filter(r => r.payment_status === 'paid').reduce((sum, r) => sum + r.total_amount_cents, 0);

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        <div style={{ marginBottom: 32 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
            ← Back to dashboard
          </button>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Registrations</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 0' }}>
            {tournaments.length > 1 ? (
              <select
                value={selectedTournament}
                onChange={e => setSelectedTournament(e.target.value)}
                style={{ padding: '6px 10px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 13.5, fontFamily: "'DM Sans', sans-serif", color: '#1A1F1C', background: '#fff', cursor: 'pointer' }}
              >
                {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <span style={{ color: '#6B7775', fontSize: 14 }}>{tournaments[0]?.name}</span>
            )}
            <span style={{ color: '#6B7775', fontSize: 14 }}>
              {registrations.length} {registrations.length === 1 ? 'registration' : 'registrations'} · {fmtMoney(paidTotal)} collected
            </span>
          </div>
        </div>

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#B91C1C', marginBottom: 16 }}>
            {error}
          </div>
        )}

        {registrations.length === 0 ? (
          <div style={{ ...s.card, padding: '48px 32px', textAlign: 'center' }}>
            <p style={{ fontSize: 32, marginBottom: 12 }}>⛳</p>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 8 }}>No registrations yet</p>
            <p style={{ color: '#6B7775', fontSize: 14 }}>Share your microsite registration link to start filling foursomes.</p>
          </div>
        ) : (
          <div style={s.card}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E0D5', background: '#FAF8F3' }}>
                  {['Contact', 'Type', 'Team', 'Foursome', 'Amount', 'Status', ''].map(h => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {registrations.map((r, i) => {
                  const st = STATUS_STYLES[r.payment_status] ?? STATUS_STYLES.pending;
                  return (
                    <tr key={r.id} style={{ borderBottom: i < registrations.length - 1 ? '1px solid #E5E0D5' : 'none' }}>
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{r.contact_name}</div>
                        <a href={`mailto:${r.contact_email}`} style={{ color: '#1B6B3A', textDecoration: 'none', fontSize: 12.5 }}>{r.contact_email}</a>
                      </td>
                      <td style={{ padding: '14px 16px', fontSize: 14 }}>{TYPE_LABELS[r.registration_type] ?? r.registration_type}</td>
                      <td style={{ padding: '14px 16px', fontSize: 14, color: r.team_name ? '#1A1F1C' : '#9BA8A4' }}>{r.team_name ?? '—'}</td>
                      <td style={{ padding: '14px 16px', fontSize: 14 }}>
                        {r.foursome_number ? `#${r.foursome_number}` : '—'}
                        {r.starting_hole ? <span style={{ color: '#6B7775', fontSize: 12.5 }}> · Hole {r.starting_hole}</span> : null}
                      </td>
                      <td style={{ padding: '14px 16px', fontSize: 14, fontWeight: 600 }}>{fmtMoney(r.total_amount_cents)}</td>
                      <td style={{ padding: '14px 16px' }}>
                        <span style={{ background: st.bg, color: st.color, borderRadius: 999, padding: '3px 10px', fontWeight: 600, fontSize: 12.5 }}>
                          {st.label}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                        {r.payment_status === 'paid' && (
                          <button
                            onClick={() => handleRefund(r)}
                            disabled={refunding === r.id}
                            style={{ background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '6px 12px', cursor: refunding === r.id ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 600, color: '#B8442C', fontFamily: "'DM Sans', sans-serif", opacity: refunding === r.id ? 0.6 : 1 }}
                          >
                            {refunding === r.id ? 'Refunding…' : 'Refund'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
