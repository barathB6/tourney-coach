'use client';

import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Signup = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
  created_at: string;
};

const ROLE_LABELS: Record<string, string> = {
  registration: 'Registration / Check-in',
  scoring: 'Scoring',
  marshal: 'Course Marshal',
  setup: 'Setup / Breakdown',
  other: 'Other',
};

export default function VolunteersPage() {
  const router = useRouter();
  const [signups, setSignups] = useState<Signup[]>([]);
  const [tournamentName, setTournamentName] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function removeVolunteer(id: string) {
    setRemovingId(id);
    const { error } = await supabase.from('volunteer_signups').delete().eq('id', id);
    if (error) {
      alert(`Could not remove volunteer: ${error.message}`);
    } else {
      setSignups(prev => prev.filter(v => v.id !== id));
    }
    setRemovingId(null);
    setConfirmingId(null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (!user) { router.replace('/sign-in'); return; }

      const { data: tournament } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!tournament) { setLoading(false); return; }
      setTournamentName(tournament.name);

      const { data } = await supabase
        .from('volunteer_signups')
        .select('id, name, email, phone, role, created_at')
        .eq('tournament_id', tournament.id)
        .order('created_at', { ascending: false });

      setSignups(data ?? []);
      setLoading(false);
    });
  }, [router]);

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 8, overflow: 'hidden' },
  };

  if (loading) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>

        <div style={{ marginBottom: 32 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
            ← Back to dashboard
          </button>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Volunteer Sign-Ups</h1>
          <p style={{ color: '#6B7775', margin: '4px 0 0', fontSize: 14 }}>{tournamentName} · {signups.length} {signups.length === 1 ? 'person' : 'people'}</p>
        </div>

        {signups.length === 0 ? (
          <div style={{ ...s.card, padding: '48px 32px', textAlign: 'center' }}>
            <p style={{ fontSize: 32, marginBottom: 12 }}>🙌</p>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 8 }}>No volunteers yet</p>
            <p style={{ color: '#6B7775', fontSize: 14 }}>Share your microsite volunteer link to start collecting sign-ups.</p>
          </div>
        ) : (
          <div style={s.card}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E5E0D5', background: '#FAF8F3' }}>
                  {['Name', 'Email', 'Phone', 'Role', 'Signed Up', ''].map((h, i) => (
                    <th key={i} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signups.map((s, i) => (
                  <tr key={s.id} style={{ borderBottom: i < signups.length - 1 ? '1px solid #E5E0D5' : 'none' }}>
                    <td style={{ padding: '14px 16px', fontWeight: 600, fontSize: 14 }}>{s.name}</td>
                    <td style={{ padding: '14px 16px', fontSize: 14 }}>
                      <a href={`mailto:${s.email}`} style={{ color: '#1B6B3A', textDecoration: 'none' }}>{s.email}</a>
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: 14, color: s.phone ? '#1A1F1C' : '#9BA8A4' }}>{s.phone ?? '—'}</td>
                    <td style={{ padding: '14px 16px', fontSize: 13 }}>
                      {s.role ? (
                        <span style={{ background: '#EAF2ED', color: '#1B6B3A', borderRadius: 999, padding: '3px 10px', fontWeight: 600 }}>
                          {ROLE_LABELS[s.role] ?? s.role}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: 13, color: '#6B7775' }}>
                      {new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {confirmingId === s.id ? (
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <button
                            onClick={() => removeVolunteer(s.id)}
                            disabled={removingId === s.id}
                            style={{ background: '#C0392B', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: removingId === s.id ? 0.6 : 1 }}
                          >
                            {removingId === s.id ? 'Removing…' : 'Remove'}
                          </button>
                          <button
                            onClick={() => setConfirmingId(null)}
                            style={{ background: 'none', color: '#6B7775', border: '1px solid #E5E0D5', borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmingId(s.id)}
                          title="Remove volunteer"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#9BA8A4', display: 'inline-flex' }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#C0392B')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#9BA8A4')}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
