"use client";
import React, { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import supabase from "../../lib/supabaseClient";
import VolunteerSignIn from "./VolunteerSignIn";

// Google Identity Services types are minimal here — we only use the one
// method (renderButton + a credential callback), no need for the full SDK types.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const doorStyle = (primary: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
  background: '#fff', border: `1px solid ${primary ? 'var(--primary)' : 'var(--line)'}`,
  borderRadius: 14, padding: '18px 20px', cursor: 'pointer', width: '100%',
  color: 'var(--ink)', fontFamily: "'DM Sans', sans-serif",
  boxShadow: '0 4px 24px rgba(15,74,38,.08)',
});

export default function SignInClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams?.get('next') || '/dashboard';
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [gsiReady, setGsiReady] = useState(false);
  // Two audiences, two doors. Organizers have accounts; volunteers never will.
  // Showing both up front stops a volunteer bouncing off a Google button that
  // was never meant for them — which, before this, was the only thing here.
  const [role, setRole] = useState<'choose' | 'organizer' | 'volunteer'>('choose');
  const buttonRef = useRef<HTMLDivElement>(null);
  // Derived during render, not set from an effect: whether Google sign-in is
  // configured is a fact about the build, not an event to react to.
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const configError = clientId ? null : 'Sign-in is misconfigured — missing Google client ID.';

  useEffect(() => {
    // Use getSession (reads localStorage, no network) to check existing auth
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace(next);
      } else {
        setChecking(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const handleCredentialResponse = async (response: { credential: string }) => {
    setError(null);
    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: response.credential,
    });
    if (error) {
      setError(error.message);
      return;
    }
    router.replace(next);
  };

  useEffect(() => {
    if (checking || role !== 'organizer' || !clientId) return;

    // Google Identity Services runs the whole flow client-side on our own
    // domain (no Supabase-hosted redirect), so the Google account picker
    // shows "tourneycoach.com" instead of the Supabase project URL.
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => setGsiReady(true);
    script.onerror = () => setError('Could not load Google sign-in. Check your connection and try again.');
    document.head.appendChild(script);
    return () => { if (script.parentNode) document.head.removeChild(script); };
  }, [checking, role]);

  useEffect(() => {
    if (role !== 'organizer' || !gsiReady || !buttonRef.current || !window.google || !clientId) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
    });
    window.google.accounts.id.renderButton(buttonRef.current, {
      theme: 'outline',
      size: 'large',
      width: 376,
      shape: 'rectangular',
      text: 'signin_with',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gsiReady, role]);

  if (checking) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--cream)' }}>
        <p style={{ color: 'var(--ink)', fontSize: 14, fontFamily: "'DM Sans', sans-serif" }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--cream)' }}>
      <div style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 32, color: 'var(--deep-green)', margin: 0 }}>TourneyCoach</h1>
          <p style={{ marginTop: 8, color: 'var(--ink)', opacity: 0.6, fontFamily: "'DM Sans', sans-serif" }}>Sign in to get started</p>
        </div>

        {role === 'choose' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <button onClick={() => setRole('organizer')} style={doorStyle(true)}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>🏌️</span>
              <span>
                <strong style={{ display: 'block', fontSize: 16 }}>Organizer login</strong>
                <span style={{ fontSize: 13, opacity: 0.75 }}>Run your tournament — dashboard, team, sponsors</span>
              </span>
            </button>
            <button onClick={() => setRole('volunteer')} style={doorStyle(false)}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>🤝</span>
              <span>
                <strong style={{ display: 'block', fontSize: 16 }}>Volunteer login</strong>
                <span style={{ fontSize: 13, opacity: 0.75 }}>See your role, checklist and day-of updates. No password.</span>
              </span>
            </button>
          </div>
        )}

        {role === 'volunteer' && <VolunteerSignIn onBack={() => setRole('choose')} />}

        {role === 'organizer' && (
          <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 16, padding: 24, boxShadow: '0 4px 24px rgba(15,74,38,.08)' }}>
            <button onClick={() => setRole('choose')} style={{ background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14, fontFamily: "'DM Sans', sans-serif" }}>&larr; Back</button>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div ref={buttonRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />
            </div>
            {!gsiReady && !error && !configError && (
              <p style={{ fontSize: 13, textAlign: 'center', color: 'var(--ink)', opacity: 0.5, fontFamily: "'DM Sans', sans-serif" }}>Loading sign-in…</p>
            )}
            {(error || configError) && (
              <p style={{ fontSize: 13, textAlign: 'center', color: 'var(--alert)', fontFamily: "'DM Sans', sans-serif" }}>{error || configError}</p>
            )}
          </div>
        )}

        <p style={{ marginTop: 28, fontSize: 12.5, lineHeight: 1.6, textAlign: 'center', color: 'var(--ink)', opacity: 0.55, fontFamily: "'DM Sans', sans-serif" }}>
          TourneyCoach is the AI-powered coaching platform for charity tournament organizers. The platform exists to solve one specific problem better than any incumbent: the volunteer-turnover institutional memory problem that kills most first-year charity tournaments before they reach Year 3. The mechanism is a combination of conversational AI coaching, integrated workflow software that competitors offer only as blog posts or downloadable templates, a privacy-architected player network that compounds in value with every tournament, and a patent-pending GPS data network that creates a structural moat against well-funded incumbents.
        </p>

        {/* Cue for the story section below the fold — without it the scroll
            reveal is a feature nobody discovers. */}
        <p style={{ marginTop: 22, textAlign: 'center' }}>
          <a
            href="#our-story-heading"
            style={{ color: 'var(--primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none', fontFamily: "'DM Sans', sans-serif" }}
          >
            Our Story ↓
          </a>
        </p>
      </div>
    </div>
  );
}
