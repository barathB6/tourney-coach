'use client';

import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Tournament = {
  id: string;
  name: string;
  slug: string;
  event_date: string;
  cause_tagline: string | null;
};

function buildShareUrl(slug: string, src: string) {
  return `https://www.tourneycoach.com/microsite/${slug}?src=${src}`;
}

export default function SharePage() {
  const router = useRouter();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (!user) { router.replace('/sign-in?next=/dashboard/share'); return; }

      const { data } = await supabase
        .from('tournaments')
        .select('id, name, slug, event_date, cause_tagline')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      setTournament(data);
      setLoading(false);
    });
  }, [router]);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 10, padding: '20px 24px', marginBottom: 20 },
  };

  if (loading) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  if (!tournament) return (
    <div style={s.page}>
      <p>No tournament found. Set up your event first.</p>
    </div>
  );

  const dateStr = new Date(tournament.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const imageUrl = `/api/share/${tournament.id}/image`;
  const facebookUrl = buildShareUrl(tournament.slug, 'facebook');
  const instagramUrl = buildShareUrl(tournament.slug, 'instagram');
  const facebookIntent = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(facebookUrl)}`;
  const caption = `${tournament.name} is coming up on ${dateStr}!${tournament.cause_tagline ? ` ${tournament.cause_tagline}` : ''} Register at ${instagramUrl}`;

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
          ← Back to dashboard
        </button>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: '0 0 4px' }}>Share your tournament</h1>
        <p style={{ color: '#6B7775', fontSize: 14, margin: '0 0 28px' }}>{tournament.name}</p>

        <div style={s.card}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 12px' }}>Share graphic</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Tournament share graphic" style={{ width: '100%', borderRadius: 8, border: '1px solid #E5E0D5', marginBottom: 14 }} />
          <a
            href={imageUrl}
            download={`${tournament.slug}-share.png`}
            style={{ display: 'inline-block', background: '#1B4425', color: '#fff', borderRadius: 8, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, textDecoration: 'none' }}
          >
            Download image
          </a>
        </div>

        <div style={s.card}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 12px' }}>Facebook</p>
          <p style={{ fontSize: 13.5, color: '#3A3F3C', margin: '0 0 14px' }}>Opens Facebook's share dialog with your tournament link pre-filled — registrations from this link are tagged as coming from Facebook.</p>
          <a
            href={facebookIntent}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', background: '#1877F2', color: '#fff', borderRadius: 8, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, textDecoration: 'none' }}
          >
            Share to Facebook
          </a>
        </div>

        <div style={s.card}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 12px' }}>Instagram</p>
          <p style={{ fontSize: 13.5, color: '#3A3F3C', margin: '0 0 14px', lineHeight: 1.6 }}>
            Instagram doesn&rsquo;t support pre-filled posts from a browser — download the image above, then copy this caption into the Instagram app.
          </p>
          <div style={{ background: '#FAF8F3', border: '1px solid #E5E0D5', borderRadius: 8, padding: '12px 14px', fontSize: 13.5, color: '#1A1F1C', marginBottom: 12, lineHeight: 1.6 }}>
            {caption}
          </div>
          <button
            onClick={() => copy(caption, 'caption')}
            style={{ background: 'none', border: '1px solid #E5E0D5', borderRadius: 8, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', color: '#1A1F1C', fontFamily: "'DM Sans', sans-serif" }}
          >
            {copied === 'caption' ? 'Copied ✓' : 'Copy caption + link'}
          </button>
        </div>

        <div style={s.card}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 12px' }}>Direct link</p>
          <p style={{ fontSize: 13.5, color: '#3A3F3C', margin: '0 0 14px' }}>For email, text, or anywhere else — registrations from this link are tagged as &ldquo;other.&rdquo;</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={buildShareUrl(tournament.slug, 'other')} style={{ flex: 1, padding: '9px 12px', border: '1px solid #E5E0D5', borderRadius: 8, fontSize: 13, color: '#3A3F3C' }} />
            <button
              onClick={() => copy(buildShareUrl(tournament.slug, 'other'), 'link')}
              style={{ background: '#1B4425', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {copied === 'link' ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
