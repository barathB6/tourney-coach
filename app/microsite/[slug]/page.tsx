import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import LiveSpotsStat from '@/components/LiveSpotsStat';
import { renderRichText } from '@/lib/richtext/render';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function getTournament(slug: string) {
  const { data } = await getSupabase()
    .from('tournaments')
    .select('id, name, slug, event_date, format, max_players, entry_fee_cents, cause_story, status, microsite_color, social_links, sponsor_logos, cause_photos, contact_email, location_name, volunteer_info, cause_tagline, edition_label, shotgun_time, historical_raised_cents, cause_org, sponsor_hole_url')
    .eq('slug', slug)
    .in('status', ['published', 'live', 'completed'])
    .single();
  return data;
}

async function getRegistrationCount(tournamentId: string) {
  const { count } = await getSupabase()
    .from('registrations')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', tournamentId);
  return count ?? 0;
}

const EVENT_STATUS: Record<string, string> = {
  published: 'https://schema.org/EventScheduled',
  live: 'https://schema.org/EventScheduled',
  completed: 'https://schema.org/EventPast',
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTournament(slug);
  if (!t) return { title: 'Tournament Not Found' };

  const dateStr = new Date(t.event_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // Subdomains (slug.tourneycoach.com) don't resolve yet — wildcard SSL/DNS
  // is still pending (Day 8). The path URL is what actually works, so use
  // it for canonical/OG/JSON-LD until that's sorted, or crawlers and rich
  // results validators will hit a dead link.
  const canonicalUrl = `https://www.tourneycoach.com/microsite/${slug}`;
  const description = (t.cause_tagline ?? t.cause_story?.slice(0, 155) ?? `Join us for ${t.name} on ${dateStr}.`).slice(0, 160);
  const ogImage = (t.cause_photos as string[])?.[0];

  return {
    title: `${t.name} — TourneyCoach`,
    description,
    metadataBase: new URL('https://tourneycoach.com'),
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: t.name,
      description,
      type: 'website',
      url: canonicalUrl,
      siteName: 'TourneyCoach',
      ...(ogImage ? { images: [{ url: ogImage, width: 1200, height: 630, alt: t.name }] } : {}),
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title: t.name,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
    robots: { index: true, follow: true },
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

function formatMoney(cents: number) {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toLocaleString()}`;
}

function daysUntil(dateStr: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const event = new Date(dateStr);
  event.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((event.getTime() - today.getTime()) / 86_400_000));
}

export default async function MicrositePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ src?: string }>;
}) {
  const { slug } = await params;
  const { src } = await searchParams;
  const t = await getTournament(slug);
  if (!t) notFound();

  const [regCount] = await Promise.all([getRegistrationCount(t.id)]);
  // Preserve the attribution tag (from a shared link) through to registration
  const registerUrl = `/register?id=${t.id}${src ? `&src=${encodeURIComponent(src)}` : ''}`;

  const dateStr = new Date(t.event_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const foursomes = Math.floor(t.max_players / 4);
  const spotsClaimed = Math.floor(regCount);
  const primaryColor = t.microsite_color ?? '#1B6B3A';
  const photos = (t.cause_photos as string[]) ?? [];
  const sponsors = (t.sponsor_logos as { name: string; logo_url: string; url?: string }[]) ?? [];
  const socials = (t.social_links as Record<string, string>) ?? {};
  const raisedCents = (t.historical_raised_cents as number) ?? 0;
  const daysLeft = daysUntil(t.event_date);
  const isCompleted = t.status === 'completed';

  // Subdomains (slug.tourneycoach.com) don't resolve yet — wildcard SSL/DNS
  // is still pending (Day 8). The path URL is what actually works, so use
  // it for canonical/OG/JSON-LD until that's sorted, or crawlers and rich
  // results validators will hit a dead link.
  const canonicalUrl = `https://www.tourneycoach.com/microsite/${slug}`;
  const ogImage = photos[0] ?? null;

  const navLinks = [
    { href: '#cause', label: 'Our Cause' },
    { href: '#format', label: 'Format' },
    ...(sponsors.length > 0 ? [{ href: '#sponsors', label: 'Sponsors' }] : []),
    ...(t.location_name ? [{ href: '#course', label: 'Course' }] : []),
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SportsEvent',
            name: t.name,
            url: canonicalUrl,
            description: t.cause_tagline ?? t.cause_story ?? undefined,
            startDate: t.event_date,
            endDate: t.event_date,
            eventStatus: EVENT_STATUS[t.status] ?? 'https://schema.org/EventScheduled',
            eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
            location: t.location_name
              ? { '@type': 'Place', name: t.location_name }
              : undefined,
            image: ogImage ? [ogImage] : undefined,
            organizer: { '@type': 'Organization', name: 'TourneyCoach', url: 'https://tourneycoach.com' },
            offers: t.entry_fee_cents
              ? {
                  '@type': 'Offer',
                  price: (t.entry_fee_cents / 100).toFixed(2),
                  priceCurrency: 'USD',
                  availability: isCompleted ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
                  url: `${canonicalUrl}#register`,
                }
              : undefined,
          }),
        }}
      />

      <div style={{ fontFamily: "'DM Sans', sans-serif", color: '#1A1F1C', minHeight: '100vh', background: '#FAF8F3' }}>

        {/* Sticky Navbar */}
        <nav style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(27, 107, 58, 0.97)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 56,
        }}>
          <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 16, color: '#fff', letterSpacing: '-0.01em' }}>
            {t.name}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {navLinks.map(link => (
              <a key={link.href} href={link.href} style={{
                color: 'rgba(255,255,255,0.8)',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 500,
                padding: '6px 12px',
                borderRadius: 4,
                letterSpacing: '0.01em',
              }}>
                {link.label}
              </a>
            ))}
            {!isCompleted && (
              <Link href={registerUrl} style={{
                marginLeft: 8,
                background: '#C8A04A',
                color: '#fff',
                fontWeight: 700,
                fontSize: 13,
                padding: '7px 16px',
                borderRadius: 4,
                textDecoration: 'none',
                letterSpacing: '0.02em',
              }}>
                Register →
              </Link>
            )}
          </div>
        </nav>

        {/* Hero */}
        <div style={{
          background: primaryColor,
          padding: '72px 24px 0',
          textAlign: 'center',
          color: '#fff',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Subtle texture overlay */}
          <div style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse at 60% 0%, rgba(200,160,74,0.15) 0%, transparent 60%)',
            pointerEvents: 'none',
          }} />

          <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto' }}>
            {/* Edition / date pill */}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(255,255,255,0.12)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 100,
              padding: '5px 16px',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.1em',
              textTransform: 'uppercase' as const,
              color: 'rgba(255,255,255,0.9)',
              marginBottom: 28,
            }}>
              {t.edition_label && <span>{t.edition_label}</span>}
              {t.edition_label && <span style={{ opacity: 0.4 }}>·</span>}
              <span>{new Date(t.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
            </div>

            {/* Impact headline */}
            <h1 style={{
              fontFamily: "'Fraunces', serif",
              fontSize: 'clamp(32px, 6vw, 60px)',
              fontWeight: 900,
              margin: '0 0 24px',
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              color: '#fff',
            }}>
              {t.cause_tagline ?? t.name}
            </h1>

            {/* Details subtitle */}
            <p style={{
              fontSize: 16,
              color: 'rgba(255,255,255,0.75)',
              margin: '0 0 40px',
              letterSpacing: '0.01em',
            }}>
              {[
                t.location_name,
                t.shotgun_time ? `Shotgun ${t.shotgun_time}` : null,
                `${foursomes} foursomes`,
                FORMAT_LABELS[t.format] ?? t.format,
                t.cause_org,
              ].filter(Boolean).join('  ·  ')}
            </p>

            {/* CTA buttons */}
            {!isCompleted && (
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' as const, marginBottom: 56 }}>
                <Link href={registerUrl} style={{
                  display: 'inline-block',
                  background: '#C8A04A',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 15,
                  padding: '14px 32px',
                  borderRadius: 4,
                  textDecoration: 'none',
                  letterSpacing: '0.03em',
                  boxShadow: '0 4px 16px rgba(200,160,74,0.4)',
                }}>
                  Register a foursome
                </Link>
                {t.sponsor_hole_url ? (
                  <a href={t.sponsor_hole_url} target="_blank" rel="noopener noreferrer" style={{
                    display: 'inline-block',
                    background: 'transparent',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 15,
                    padding: '13px 32px',
                    borderRadius: 4,
                    textDecoration: 'none',
                    letterSpacing: '0.03em',
                    border: '1.5px solid rgba(255,255,255,0.5)',
                  }}>
                    Sponsor a hole
                  </a>
                ) : (
                  <Link href={`/microsite/${slug}/volunteer`} style={{
                    display: 'inline-block',
                    background: 'transparent',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 15,
                    padding: '13px 32px',
                    borderRadius: 4,
                    textDecoration: 'none',
                    letterSpacing: '0.03em',
                    border: '1.5px solid rgba(255,255,255,0.5)',
                  }}>
                    Volunteer
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* Stats strip */}
          <div style={{
            background: 'rgba(0,0,0,0.2)',
            borderTop: '1px solid rgba(255,255,255,0.1)',
            padding: '20px 24px',
            display: 'flex',
            justifyContent: 'center',
            gap: 0,
          }}>
            {[
              raisedCents > 0 ? { live: false, value: formatMoney(raisedCents), label: 'raised for the cause' } : null,
              { live: true, value: '', label: '' },
              !isCompleted ? { live: false, value: daysLeft === 0 ? 'Today' : `${daysLeft}`, label: daysLeft === 0 ? 'tee off day' : 'days to tee off' } : null,
            ].filter(Boolean).map((stat, i, arr) => (
              <div key={i} style={{
                textAlign: 'center',
                padding: '0 40px',
                borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.15)' : 'none',
              }}>
                {stat!.live ? (
                  <LiveSpotsStat tournamentId={t.id} initialCount={spotsClaimed} foursomesTotal={foursomes} />
                ) : (
                  <>
                    <p style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: '0 0 4px', color: '#fff' }}>
                      {stat!.value}
                    </p>
                    <p style={{ fontSize: 12, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                      {stat!.label}
                    </p>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Body content */}
        <div style={{ maxWidth: 800, margin: '0 auto', padding: '64px 24px' }}>

          {/* Cause story */}
          {t.cause_story && (
            <section id="cause" style={{ marginBottom: 64, scrollMarginTop: 72 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 700, color: primaryColor, marginBottom: 20 }}>
                Why We Play
              </h2>
              <div style={{ fontSize: 17, lineHeight: 1.8, color: '#3A3F3C' }}>
                {renderRichText(t.cause_story)}
              </div>
            </section>
          )}

          {/* Photo gallery */}
          {photos.length > 0 && (
            <section style={{ marginBottom: 64 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                {photos.map((url, i) => (
                  <img key={i} src={url} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 8 }} />
                ))}
              </div>
            </section>
          )}

          {/* Format */}
          <section id="format" style={{ marginBottom: 64, scrollMarginTop: 72 }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 700, color: primaryColor, marginBottom: 24 }}>
              Event Details
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
              {[
                { label: 'Format', value: FORMAT_LABELS[t.format] ?? t.format },
                { label: 'Foursomes', value: `${foursomes} teams` },
                { label: 'Entry Fee', value: `$${(t.entry_fee_cents / 100).toFixed(0)} / team` },
                ...(t.shotgun_time ? [{ label: 'Shotgun Start', value: t.shotgun_time }] : []),
                ...(t.location_name ? [{ label: 'Course', value: t.location_name }] : []),
              ].map(({ label, value }) => (
                <div key={label} style={{
                  background: '#fff',
                  border: '1px solid #E5E0D5',
                  borderRadius: 8,
                  padding: '20px',
                }}>
                  <p style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#6B7775', margin: '0 0 6px' }}>{label}</p>
                  <p style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#1A1F1C' }}>{value}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Sponsors */}
          {sponsors.length > 0 && (
            <section id="sponsors" style={{ marginBottom: 64, scrollMarginTop: 72 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 700, color: primaryColor, marginBottom: 24 }}>
                Our Sponsors
              </h2>
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 24, alignItems: 'center' }}>
                {sponsors.map((s, i) => (
                  s.url ? (
                    <a key={i} href={s.url} target="_blank" rel="noopener noreferrer">
                      <img src={s.logo_url} alt={s.name} style={{ height: 52, objectFit: 'contain' }} />
                    </a>
                  ) : (
                    <img key={i} src={s.logo_url} alt={s.name} style={{ height: 52, objectFit: 'contain' }} />
                  )
                ))}
              </div>
            </section>
          )}

          {/* Volunteer CTA */}
          <section style={{
            background: '#fff',
            border: `2px solid ${primaryColor}`,
            borderRadius: 10,
            padding: '36px 32px',
            marginBottom: 64,
            textAlign: 'center',
          }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, color: primaryColor, marginBottom: 10 }}>
              Volunteer With Us
            </h2>
            <p style={{ color: '#3A3F3C', marginBottom: 24, lineHeight: 1.7 }}>
              {t.volunteer_info ?? 'Help make this event possible. We need volunteers for registration, scoring, course marshaling, and more.'}
            </p>
            <Link href={`/microsite/${slug}/volunteer`} style={{
              display: 'inline-block',
              background: primaryColor,
              color: '#fff',
              fontWeight: 700,
              fontSize: 15,
              padding: '12px 28px',
              borderRadius: 4,
              textDecoration: 'none',
            }}>
              Sign Up to Volunteer
            </Link>
          </section>

          {/* Bottom register CTA */}
          {!isCompleted && (
            <section style={{ textAlign: 'center', marginBottom: 48 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 700, marginBottom: 12 }}>
                Ready to Play?
              </h2>
              <p style={{ color: '#3A3F3C', marginBottom: 28, fontSize: 16 }}>
                Secure your foursome before spots fill up.
              </p>
              <Link href={registerUrl} style={{
                display: 'inline-block',
                background: '#C8A04A',
                color: '#fff',
                fontWeight: 700,
                fontSize: 17,
                padding: '16px 48px',
                borderRadius: 4,
                textDecoration: 'none',
                boxShadow: '0 4px 16px rgba(200,160,74,0.35)',
              }}>
                Register a foursome →
              </Link>
            </section>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #E5E0D5', padding: '32px 24px', textAlign: 'center' }}>
          {t.contact_email && (
            <p style={{ color: '#6B7775', fontSize: 14, marginBottom: 12 }}>
              Questions? <a href={`mailto:${t.contact_email}`} style={{ color: primaryColor }}>{t.contact_email}</a>
            </p>
          )}
          {Object.keys(socials).length > 0 && (
            <div style={{ marginBottom: 20 }}>
              {Object.entries(socials).map(([platform, url]) =>
                url ? (
                  <a key={platform} href={url} target="_blank" rel="noopener noreferrer"
                    style={{ marginRight: 16, color: primaryColor, fontSize: 14, fontWeight: 600, textTransform: 'capitalize' as const }}>
                    {platform}
                  </a>
                ) : null
              )}
            </div>
          )}
          <p style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: '#B0ABA3', margin: 0 }}>
            A TOURNEYCOACH MICROSITE · POWERED BY{' '}
            <a href="https://tourneycoach.com" style={{ color: '#B0ABA3' }}>TOURNEYCOACH.COM</a>
          </p>
        </div>
      </div>
    </>
  );
}
