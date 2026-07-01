'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import supabase from '@/lib/supabaseClient';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [status, setStatus] = useState('Signing you in...');

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const next = url.searchParams.get('next') || '/dashboard';

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(async ({ data, error }) => {
        if (error) {
          console.error('Auth exchange failed:', error.message);
          setStatus('Sign-in failed. Redirecting...');
        } else if (data.session?.provider_token && !data.user?.user_metadata?.avatar_url) {
          try {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${data.session.provider_token}` },
            });
            const profile = await res.json();
            if (profile.picture) {
              await supabase.auth.updateUser({ data: { avatar_url: profile.picture } });
            }
          } catch { /* avatar is optional */ }
        }
        router.replace(next);
      });
    } else {
      router.replace(next);
    }
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--cream)' }}>
      <p className="text-sm" style={{ color: 'var(--ink)' }}>{status}</p>
    </div>
  );
}
