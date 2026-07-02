'use client';

import { createClient } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type MicrositeFields = {
  slug: string;
  microsite_color: string;
  contact_email: string;
  location_name: string;
  volunteer_info: string;
  social_links: { instagram?: string; facebook?: string; twitter?: string };
};

type Tournament = MicrositeFields & { id: string; name: string; status: string };

export default function MicrositeEditorPage() {
  const router = useRouter();
  const supabase = createClient();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [form, setForm] = useState<MicrositeFields>({
    slug: '',
    microsite_color: '#1B6B3A',
    contact_email: '',
    location_name: '',
    volunteer_info: '',
    social_links: {},
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.replace('/sign-in?next=/dashboard/microsite'); return; }

      const { data } = await supabase
        .from('tournaments')
        .select('id, name, status, slug, microsite_color, contact_email, location_name, volunteer_info, social_links')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data) {
        setTournament(data as Tournament);
        setForm({
          slug: data.slug ?? '',
          microsite_color: data.microsite_color ?? '#1B6B3A',
          contact_email: data.contact_email ?? '',
          location_name: data.location_name ?? '',
          volunteer_info: data.volunteer_info ?? '',
          social_links: (data.social_links as MicrositeFields['social_links']) ?? {},
        });
      }
    });
  }, []);

  const set = (key: keyof MicrositeFields, value: string) =>
    setForm(f => ({ ...f, [key]: value }));

  const setSocial = (key: string, value: string) =>
    setForm(f => ({ ...f, social_links: { ...f.social_links, [key]: value } }));

  const handleSave = async () => {
    if (!tournament) return;
    setSaving(true);
    setError('');
    setSaved(false);

    const { error: err } = await supabase
      .from('tournaments')
      .update({
        microsite_color: form.microsite_color,
        contact_email: form.contact_email || null,
        location_name: form.location_name || null,
        volunteer_info: form.volunteer_info || null,
        social_links: form.social_links,
      })
      .eq('id', tournament.id);

    setSaving(false);
    if (err) { setError(err.message); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const micrositeUrl = form.slug
    ? `https://${form.slug}.tourneycoach.com`
    : null;

  const s = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' } as React.CSSProperties,
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 8, padding: '28px', marginBottom: 20 } as React.CSSProperties,
    label: { display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#6B7775', marginBottom: 6 },
    input: { width: '100%', padding: '10px 12px', border: '1px solid #E5E0D5', borderRadius: 4, fontSize: 15, background: '#FAFAF8', boxSizing: 'border-box' as const },
    textarea: { width: '100%', padding: '10px 12px', border: '1px solid #E5E0D5', borderRadius: 4, fontSize: 15, background: '#FAFAF8', boxSizing: 'border-box' as const, minHeight: 100, resize: 'vertical' as const },
    btn: { padding: '12px 28px', background: '#1B6B3A', color: '#fff', fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 4, cursor: 'pointer' },
    row: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  };

  if (!tournament) return (
    <div style={{ ...s.page, textAlign: 'center', paddingTop: 80 }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
          <div>
            <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
              ← Back to dashboard
            </button>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Microsite Editor</h1>
            <p style={{ color: '#6B7775', margin: '4px 0 0', fontSize: 14 }}>{tournament.name}</p>
          </div>
          {micrositeUrl && (
            <a href={micrositeUrl} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 13, color: '#1B6B3A', border: '1px solid #1B6B3A', padding: '6px 14px', borderRadius: 4, textDecoration: 'none', whiteSpace: 'nowrap' }}>
              View live ↗
            </a>
          )}
        </div>

        {/* URL */}
        <div style={s.card}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 16, marginTop: 0 }}>Your Microsite URL</h2>
          <div style={{ background: '#F0F4F2', borderRadius: 4, padding: '12px 16px', fontFamily: 'monospace', fontSize: 14, color: '#1B6B3A' }}>
            {micrositeUrl ?? 'Publish your tournament to activate your microsite'}
          </div>
          {micrositeUrl && (
            <p style={{ fontSize: 12, color: '#6B7775', marginTop: 8 }}>
              Share this link with players, sponsors, and supporters.
            </p>
          )}
        </div>

        {/* Brand color */}
        <div style={s.card}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 16, marginTop: 0 }}>Brand Color</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <input type="color" value={form.microsite_color} onChange={e => set('microsite_color', e.target.value)}
              style={{ width: 48, height: 48, border: '1px solid #E5E0D5', borderRadius: 4, cursor: 'pointer', padding: 2 }} />
            <div>
              <p style={{ margin: '0 0 4px', fontWeight: 600 }}>{form.microsite_color}</p>
              <p style={{ margin: 0, fontSize: 13, color: '#6B7775' }}>Used for headings, buttons, and accents on your microsite</p>
            </div>
          </div>
        </div>

        {/* Event details */}
        <div style={s.card}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 20, marginTop: 0 }}>Event Details</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={s.row}>
              <label style={s.label}>Venue / Location Name</label>
              <input style={s.input} value={form.location_name} onChange={e => set('location_name', e.target.value)}
                placeholder="Pebble Beach Golf Links" />
            </div>
            <div style={s.row}>
              <label style={s.label}>Contact Email</label>
              <input style={s.input} type="email" value={form.contact_email} onChange={e => set('contact_email', e.target.value)}
                placeholder="organizer@yourorg.com" />
            </div>
          </div>
        </div>

        {/* Volunteer info */}
        <div style={s.card}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 8, marginTop: 0 }}>Volunteer Recruitment</h2>
          <p style={{ fontSize: 13, color: '#6B7775', marginBottom: 16 }}>
            This text appears on your volunteer sign-up page at <code>{form.slug ? `${form.slug}.tourneycoach.com/volunteer` : 'your-event.tourneycoach.com/volunteer'}</code>
          </p>
          <div style={s.row}>
            <label style={s.label}>What volunteers should know</label>
            <textarea style={s.textarea} value={form.volunteer_info} onChange={e => set('volunteer_info', e.target.value)}
              placeholder="We need help with registration, course marshaling, and scoring. Volunteers receive a free lunch and event t-shirt." />
          </div>
        </div>

        {/* Social links */}
        <div style={s.card}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, marginBottom: 20, marginTop: 0 }}>Social Media</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(['instagram', 'facebook', 'twitter'] as const).map(platform => (
              <div key={platform} style={s.row}>
                <label style={s.label}>{platform.charAt(0).toUpperCase() + platform.slice(1)}</label>
                <input style={s.input} value={(form.social_links as Record<string, string>)[platform] ?? ''}
                  onChange={e => setSocial(platform, e.target.value)}
                  placeholder={`https://${platform}.com/yourpage`} />
              </div>
            ))}
          </div>
        </div>

        {/* Save */}
        {error && <p style={{ color: '#B8442C', fontSize: 14, marginBottom: 12 }}>{error}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 48 }}>
          <button style={s.btn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          {saved && <p style={{ color: '#1B6B3A', fontSize: 14, margin: 0 }}>✓ Saved</p>}
        </div>
      </div>
    </div>
  );
}
