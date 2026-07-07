'use client';

import { supabase } from '@/lib/supabaseClient';
import { useRouter, useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type Registration = {
  id: string;
  registration_type: string;
  team_name: string | null;
  contact_name: string;
  contact_email: string;
  players: { name: string; email: string }[];
  payment_status: string;
  foursome_number: number | null;
  starting_hole: number | null;
  checked_in_at: string | null;
  tournaments: { name: string; organizer_id: string } | null;
};

const TYPE_LABELS: Record<string, string> = {
  foursome: 'Foursome',
  single: 'Single',
  sponsor: 'Sponsor',
};

export default function CheckinPage() {
  const router = useRouter();
  const params = useParams();
  const regId = params.id as string;

  const [reg, setReg] = useState<Registration | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingIn, setCheckingIn] = useState(false);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  async function load() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) { router.replace(`/sign-in?next=/checkin/${regId}`); return; }

    const { data, error: err } = await supabase
      .from('registrations')
      .select('id, registration_type, team_name, contact_name, contact_email, players, payment_status, foursome_number, starting_hole, checked_in_at, tournaments(name, organizer_id)')
      .eq('id', regId)
      .single();

    if (err || !data) { setNotFound(true); setLoading(false); return; }
    setReg(data as unknown as Registration);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [regId]);

  async function handleCheckin() {
    setCheckingIn(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in');

      const res = await fetch(`/api/registrations/${regId}/checkin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok && res.status !== 409) throw new Error(data.error || 'Check-in failed');

      setReg(prev => prev ? { ...prev, checked_in_at: data.checked_in_at } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check-in failed');
    } finally {
      setCheckingIn(false);
    }
  }

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: '32px 28px', maxWidth: 420, width: '100%' },
  };

  if (loading) return <div style={s.page}><p style={{ color: '#6B7775' }}>Loading…</p></div>;

  if (notFound || !reg) return (
    <div style={s.page}>
      <div style={{ ...s.card, textAlign: 'center' }}>
        <p style={{ fontSize: 32, marginBottom: 8 }}>❓</p>
        <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 6 }}>Registration not found</p>
        <p style={{ color: '#6B7775', fontSize: 13.5 }}>This QR code doesn&rsquo;t match a registration you can access.</p>
      </div>
    </div>
  );

  const alreadyIn = !!reg.checked_in_at;

  return (
    <div style={s.page}>
      <div style={s.card}>
        <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 4px' }}>
          {reg.tournaments?.name}
        </p>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, margin: '0 0 20px' }}>{reg.contact_name}</h1>

        <div style={{ borderTop: '1px solid #E5E0D5', borderBottom: '1px solid #E5E0D5', padding: '14px 0', marginBottom: 20 }}>
          {[
            ['Type', TYPE_LABELS[reg.registration_type] ?? reg.registration_type],
            ...(reg.team_name ? [['Team', reg.team_name]] : []),
            ['Foursome', reg.foursome_number ? `#${reg.foursome_number}` : '—'],
            ...(reg.starting_hole ? [['Starting hole', `${reg.starting_hole}`]] : []),
            ['Payment', reg.payment_status === 'paid' ? 'Paid ✓' : reg.payment_status],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 14 }}>
              <span style={{ color: '#6B7775' }}>{label}</span>
              <span style={{ fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>

        {reg.players?.length > 1 && (
          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 8px' }}>Players</p>
            {reg.players.map((p, i) => (
              <p key={i} style={{ fontSize: 14, margin: '2px 0' }}>{p.name}</p>
            ))}
          </div>
        )}

        {error && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#B91C1C', marginBottom: 14 }}>
            {error}
          </div>
        )}

        {alreadyIn ? (
          <div style={{ background: '#EAF2ED', border: '1px solid #C8DDD1', borderRadius: 10, padding: '14px', textAlign: 'center' }}>
            <p style={{ fontWeight: 700, color: '#1B6B3A', fontSize: 15, margin: 0 }}>✓ Checked in</p>
            <p style={{ fontSize: 12.5, color: '#5C6B62', margin: '4px 0 0' }}>
              {new Date(reg.checked_in_at!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </p>
          </div>
        ) : (
          <button
            onClick={handleCheckin}
            disabled={checkingIn}
            style={{ width: '100%', padding: '14px', background: '#1B4425', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: checkingIn ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: checkingIn ? 0.7 : 1 }}
          >
            {checkingIn ? 'Checking in…' : 'Check in'}
          </button>
        )}
      </div>
    </div>
  );
}
