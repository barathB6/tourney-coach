'use client';

import { supabase } from '@/lib/supabaseClient';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

type Tournament = {
  id: string;
  name: string;
  event_date: string;
  microsite_color: string | null;
  volunteer_info: string | null;
  contact_email: string | null;
};

export default function VolunteerPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase
      .from('tournaments')
      .select('id, name, event_date, microsite_color, volunteer_info, contact_email')
      .eq('slug', slug)
      .in('status', ['published', 'live', 'completed'])
      .single()
      .then((res) => setTournament(res.data));
  }, [slug]);

  const primaryColor = tournament?.microsite_color ?? '#1B6B3A';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email) { setError('Name and email are required.'); return; }
    setSubmitting(true);
    setError('');

    // For now, send to organizer email via a simple mailto or just show success.
    // Volunteer signups table can be added when ready.
    await new Promise(r => setTimeout(r, 600));
    setSubmitted(true);
    setSubmitting(false);
  };

  if (!tournament) return null;

  const dateStr = new Date(tournament.event_date).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const s = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', color: '#1A1F1C' } as React.CSSProperties,
    header: { background: primaryColor, padding: '40px 24px', textAlign: 'center' as const, color: '#fff' },
    body: { maxWidth: 560, margin: '0 auto', padding: '48px 24px' },
    label: { display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 6, color: '#3A3F3C' },
    input: { width: '100%', padding: '10px 12px', border: '1px solid #E5E0D5', borderRadius: 4, fontSize: 15, background: '#fff', boxSizing: 'border-box' as const },
    btn: { width: '100%', padding: '14px', background: primaryColor, color: '#fff', fontWeight: 700, fontSize: 16, border: 'none', borderRadius: 4, cursor: 'pointer' },
  };

  if (submitted) return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, margin: 0 }}>{tournament.name}</h1>
      </div>
      <div style={{ ...s.body, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🙌</div>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, marginBottom: 12 }}>Thank you, {name}!</h2>
        <p style={{ color: '#3A3F3C', lineHeight: 1.7 }}>
          We&apos;ll be in touch closer to the event with details about your volunteer role.
          {tournament.contact_email && ` Questions? Email us at ${tournament.contact_email}.`}
        </p>
      </div>
    </div>
  );

  return (
    <div style={s.page}>
      <div style={s.header}>
        <p style={{ fontSize: 13, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.8, marginBottom: 8 }}>
          {dateStr}
        </p>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, margin: '0 0 8px' }}>{tournament.name}</h1>
        <p style={{ opacity: 0.85, fontSize: 16, margin: 0 }}>Volunteer Sign-Up</p>
      </div>

      <div style={s.body}>
        {tournament.volunteer_info && (
          <p style={{ color: '#3A3F3C', lineHeight: 1.75, marginBottom: 32, fontSize: 16 }}>
            {tournament.volunteer_info}
          </p>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <label style={s.label}>Full Name *</label>
            <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" />
          </div>
          <div>
            <label style={s.label}>Email *</label>
            <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" />
          </div>
          <div>
            <label style={s.label}>Phone (optional)</label>
            <input style={s.input} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 000-0000" />
          </div>
          <div>
            <label style={s.label}>Preferred Role</label>
            <select style={s.input} value={role} onChange={e => setRole(e.target.value)}>
              <option value="">Any role</option>
              <option value="registration">Registration / Check-in</option>
              <option value="scoring">Scoring</option>
              <option value="marshal">Course Marshal</option>
              <option value="setup">Setup / Breakdown</option>
              <option value="other">Other</option>
            </select>
          </div>

          {error && <p style={{ color: '#B8442C', fontSize: 14 }}>{error}</p>}

          <button type="submit" style={s.btn} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Sign Up to Volunteer'}
          </button>
        </form>
      </div>
    </div>
  );
}
