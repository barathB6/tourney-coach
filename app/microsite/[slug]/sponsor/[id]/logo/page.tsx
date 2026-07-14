'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type SponsorInfo = {
  company: string;
  status: string;
  logoUrl: string | null;
  tournamentName: string | null;
  micrositeColor: string | null;
};

export default function SponsorLogoUploadPage() {
  const params = useParams();
  const slug = params.slug as string;
  const sponsorId = params.id as string;

  const [info, setInfo] = useState<SponsorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/sponsors/${sponsorId}/logo`);
      if (res.ok) setInfo(await res.json());
      setLoading(false);
    })();
  }, [sponsorId]);

  async function handleUpload(file: File) {
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('logo', file);
      const res = await fetch(`/api/sponsors/${sponsorId}/logo`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  if (loading) return null;
  if (!info) {
    return (
      <div style={{ fontFamily: "'DM Sans', sans-serif", padding: 48, textAlign: 'center', color: '#6B7775' }}>
        This link isn&rsquo;t valid.
      </div>
    );
  }

  const primaryColor = info.micrositeColor ?? '#1B6B3A';

  if (info.status !== 'paid') {
    return (
      <div style={{ fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', color: '#1A1F1C' }}>
        <div style={{ background: primaryColor, padding: '48px 24px', textAlign: 'center', color: '#fff' }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, margin: 0 }}>{info.tournamentName}</h1>
        </div>
        <div style={{ maxWidth: 480, margin: '0 auto', padding: '48px 24px', textAlign: 'center' }}>
          <p style={{ color: '#3A3F3C', lineHeight: 1.7 }}>
            Logo uploads open once your {info.company} sponsorship is confirmed and paid. Check back after checkout, or reach out to the organizer if you think this is a mistake.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', color: '#1A1F1C' }}>
      <div style={{ background: primaryColor, padding: '48px 24px', textAlign: 'center', color: '#fff' }}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 32, margin: 0 }}>{info.tournamentName}</h1>
        <p style={{ color: 'rgba(255,255,255,0.8)', margin: '8px 0 0' }}>Upload your logo — {info.company}</p>
      </div>

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '48px 24px', textAlign: 'center' }}>
        {done || info.logoUrl ? (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 24, marginBottom: 12 }}>Logo received</h2>
            <p style={{ color: '#3A3F3C', lineHeight: 1.7, marginBottom: 24 }}>
              Thanks — the organizer has your logo and will add it to the event materials and microsite.
            </p>
            <label style={{ color: primaryColor, fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
              Upload a different file
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            </label>
          </>
        ) : (
          <>
            <p style={{ color: '#3A3F3C', lineHeight: 1.7, marginBottom: 24 }}>
              Thanks for sponsoring {info.tournamentName}! Upload your logo below and we&rsquo;ll get it on the event microsite, signage, and program.
            </p>
            <label style={{
              display: 'block', border: `2px dashed ${primaryColor}`, borderRadius: 10, padding: '40px 20px',
              cursor: uploading ? 'default' : 'pointer', color: primaryColor, fontWeight: 600, background: '#fff',
              opacity: uploading ? 0.6 : 1,
            }}>
              {uploading ? 'Uploading…' : 'Choose a logo file'}
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            </label>
            <p style={{ color: '#9BA8A4', fontSize: 12, marginTop: 8 }}>PNG, JPG, or SVG — up to 5MB</p>
            {error && <p style={{ color: '#C0392B', fontSize: 13, marginTop: 12 }}>{error}</p>}
          </>
        )}
        <p style={{ marginTop: 32 }}>
          <Link href={`/microsite/${slug}`} style={{ color: primaryColor, fontWeight: 600, fontSize: 14 }}>← Back to the event page</Link>
        </p>
      </div>
    </div>
  );
}
