import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

async function getTournament(slug: string) {
  const { data } = await supabase
    .from('tournaments')
    .select('id, name, slug, event_date, format, max_players, entry_fee_cents, cause_story, status, microsite_color, social_links, sponsor_logos, cause_photos, contact_email, location_name, volunteer_info')
    .eq('slug', slug)
    .in('status', ['published', 'live', 'completed'])
    .single();
  return data;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTournament(slug);
  if (!t) return { title: 'Tournament Not Found' };

  const dateStr = new Date(t.event_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return {
    title: `${t.name} — TourneyCoach`,
    description: t.cause_story?.slice(0, 160) ?? `Join us for ${t.name} on ${dateStr}.`,
    openGraph: {
      title: t.name,
      description: t.cause_story?.slice(0, 160) ?? `Join us for ${t.name} on ${dateStr}.`,
      type: 'website',
      images: (t.cause_photos as string[])?.[0] ? [{ url: (t.cause_photos as string[])[0] }] : [],
    },
  };
}

const FORMAT_LABELS: Record<string, string> = {
  scramble: 'Scramble',
  best_ball: 'Best Ball',
  stableford: 'Stableford',
  captains_choice: "Captain's Choice",
  alternate_shot: 'Alternate Shot',
  stroke_play: 'Stroke Play',
};

export default async function MicrositePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await getTournament(slug);
  if (!t) notFound();

  const dateStr = new Date(t.event_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const foursomes = Math.floor(t.max_players / 4);
  const primaryColor = t.microsite_color ?? '#1B6B3A';
  const photos = (t.cause_photos as string[]) ?? [];
  const sponsors = (t.sponsor_logos as { name: string; logo_url: string; url?: string }[]) ?? [];
  const socials = (t.social_links as Record<string, string>) ?? {};

  return (
    <>
      {/* JSON-LD structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SportsEvent',
            name: t.name,
            startDate: t.event_date,
            location: t.location_name ? { '@type': 'Place', name: t.location_name } : undefined,
            description: t.cause_story ?? undefined,
            organizer: { '@type': 'Organization', name: 'TourneyCoach' },
          }),
        }}
      />

      <div style={{ fontFamily: "'DM Sans', sans-serif", color: '#1A1F1C', minHeight: '100vh', background: '#FAF8F3' }}>
        {/* Hero */}
        <div style={{
          background: photos[0]
            ? `linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.55)), url(${photos[0]}) center/cover`
            : primaryColor,
          padding: '80px 24px 64px',
          textAlign: 'center',
          color: '#fff',
        }}>
          <p style={{ fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.8, marginBottom: 12 }}>
            Charity Golf Tournament
          </p>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 'clamp(28px, 6vw, 52px)', fontWeight: 700, margin: '0 0 16px', lineHeight: 1.1 }}>
            {t.name}
          </h1>
          <p style={{ fontSize: 18, opacity: 0.9, marginBottom: 8 }}>{dateStr}</p>
          {t.location_name && (
            <p style={{ fontSize: 15, opacity: 0.75, marginBottom: 32 }}>{t.location_name}</p>
          )}
          {t.status !== 'completed' && (
            <Link
              href={`/register?id=${t.id}`}
              style={{
                display: 'inline-block',
                background: '#C8A04A',
                color: '#fff',
                fontWeight: 700,
                fontSize: 16,
                padding: '14px 36px',
                borderRadius: 4,
                textDecoration: 'none',
                letterSpacing: '0.04em',
              }}
            >
              Register Now
            </Link>
          )}
        </div>

        {/* Event details strip */}
        <div style={{ background: '#fff', borderBottom: '1px solid #E5E0D5', padding: '20px 24px' }}>
          <div style={{ maxWidth: 800, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 24, justifyContent: 'center' }}>
            {[
              { label: 'Format', value: FORMAT_LABELS[t.format] ?? t.format },
              { label: 'Foursomes', value: `${foursomes} spots` },
              { label: 'Entry Fee', value: `$${(t.entry_fee_cents / 100).toFixed(0)} / team` },
            ].map(({ label, value }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7775', margin: '0 0 4px' }}>{label}</p>
                <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        <div style={{ maxWidth: 800, margin: '0 auto', padding: '48px 24px' }}>
          {/* Cause story */}
          {t.cause_story && (
            <section style={{ marginBottom: 56 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, color: primaryColor, marginBottom: 16 }}>
                Why We Play
              </h2>
              <p style={{ fontSize: 17, lineHeight: 1.75, color: '#3A3F3C', whiteSpace: 'pre-line' }}>
                {t.cause_story}
              </p>
            </section>
          )}

          {/* Photo gallery */}
          {photos.length > 0 && (
            <section style={{ marginBottom: 56 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, color: primaryColor, marginBottom: 20 }}>
                Gallery
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                {photos.map((url, i) => (
                  <img key={i} src={url} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 6 }} />
                ))}
              </div>
            </section>
          )}

          {/* Volunteer CTA */}
          <section style={{
            background: '#fff',
            border: `2px solid ${primaryColor}`,
            borderRadius: 8,
            padding: '32px 28px',
            marginBottom: 56,
            textAlign: 'center',
          }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, color: primaryColor, marginBottom: 8 }}>
              Volunteer With Us
            </h2>
            <p style={{ color: '#3A3F3C', marginBottom: 20 }}>
              {t.volunteer_info ?? 'Help make this event possible. We need volunteers for registration, scoring, course marshaling, and more.'}
            </p>
            <Link
              href={`/microsite/${slug}/volunteer`}
              style={{
                display: 'inline-block',
                background: primaryColor,
                color: '#fff',
                fontWeight: 700,
                fontSize: 15,
                padding: '12px 28px',
                borderRadius: 4,
                textDecoration: 'none',
              }}
            >
              Sign Up to Volunteer
            </Link>
          </section>

          {/* Sponsors */}
          {sponsors.length > 0 && (
            <section style={{ marginBottom: 56 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, color: primaryColor, marginBottom: 20 }}>
                Our Sponsors
              </h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
                {sponsors.map((s, i) => (
                  s.url ? (
                    <a key={i} href={s.url} target="_blank" rel="noopener noreferrer">
                      <img src={s.logo_url} alt={s.name} style={{ height: 48, objectFit: 'contain' }} />
                    </a>
                  ) : (
                    <img key={i} src={s.logo_url} alt={s.name} style={{ height: 48, objectFit: 'contain' }} />
                  )
                ))}
              </div>
            </section>
          )}

          {/* Register CTA */}
          {t.status !== 'completed' && (
            <section style={{ textAlign: 'center', marginBottom: 48 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
                Ready to Play?
              </h2>
              <p style={{ color: '#3A3F3C', marginBottom: 24 }}>
                Secure your foursome before spots fill up.
              </p>
              <Link
                href={`/register?id=${t.id}`}
                style={{
                  display: 'inline-block',
                  background: '#C8A04A',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 17,
                  padding: '16px 48px',
                  borderRadius: 4,
                  textDecoration: 'none',
                }}
              >
                Register Now
              </Link>
            </section>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #E5E0D5', padding: '24px', textAlign: 'center', color: '#6B7775', fontSize: 13 }}>
          {t.contact_email && (
            <p style={{ marginBottom: 8 }}>
              Questions? <a href={`mailto:${t.contact_email}`} style={{ color: primaryColor }}>{t.contact_email}</a>
            </p>
          )}
          {Object.entries(socials).map(([platform, url]) => (
            url ? (
              <a key={platform} href={url} target="_blank" rel="noopener noreferrer"
                style={{ marginRight: 16, color: primaryColor, textTransform: 'capitalize' }}>
                {platform}
              </a>
            ) : null
          ))}
          <p style={{ marginTop: 16 }}>Powered by TourneyCoach</p>
        </div>
      </div>
    </>
  );
}
