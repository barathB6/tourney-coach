import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Generates a 1200x630 share graphic for a tournament — used for Facebook
// link previews and as a downloadable image for Instagram (which has no web
// share intent, so organizers post it manually with a copied caption).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getSupabase();

  const { data: t } = await supabase
    .from('tournaments')
    .select('name, event_date, cause_tagline, location_name, microsite_color, max_players')
    .eq('id', id)
    .single();

  if (!t) {
    return new Response('Tournament not found', { status: 404 });
  }

  const foursomes = Math.floor((t.max_players ?? 0) / 4);
  const primaryColor = t.microsite_color ?? '#1B6B3A';
  const dateStr = new Date(t.event_date).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: `linear-gradient(135deg, ${primaryColor} 0%, #0F2A18 100%)`,
          padding: '72px',
          fontFamily: 'Georgia, serif',
          position: 'relative',
        }}
      >
        <div style={{
          display: 'flex', position: 'absolute', top: 72, right: 72,
          color: '#D9C58A', fontSize: 28, fontWeight: 700, fontFamily: 'Arial, sans-serif',
        }}>
          TourneyCoach
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{
            display: 'flex', alignSelf: 'flex-start', color: '#D9C58A', fontSize: 24,
            fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 24,
            fontFamily: 'Arial, sans-serif',
          }}>
            {dateStr}
          </div>
          <div style={{ display: 'flex', color: '#ffffff', fontSize: 76, fontWeight: 700, lineHeight: 1.1, maxWidth: '1000px' }}>
            {t.name}
          </div>
          {t.cause_tagline && (
            <div style={{
              display: 'flex', color: 'rgba(255,255,255,0.85)', fontSize: 32, marginTop: 28,
              maxWidth: '950px', fontFamily: 'Arial, sans-serif', fontWeight: 400,
            }}>
              {t.cause_tagline}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 56 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', color: '#ffffff', fontSize: 48, fontWeight: 700 }}>{foursomes} foursomes</div>
            <div style={{ display: 'flex', color: 'rgba(255,255,255,0.6)', fontSize: 20, fontFamily: 'Arial, sans-serif', textTransform: 'uppercase', letterSpacing: 2 }}>spots limited but still available</div>
          </div>
          {t.location_name && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', color: '#ffffff', fontSize: 32, fontWeight: 700 }}>{t.location_name}</div>
              <div style={{ display: 'flex', color: 'rgba(255,255,255,0.6)', fontSize: 20, fontFamily: 'Arial, sans-serif', textTransform: 'uppercase', letterSpacing: 2 }}>course</div>
            </div>
          )}
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
