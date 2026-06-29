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
    const next = url.searchParams.get('next') || '/story';

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ data, error }) => {
        if (error) {
          console.error('Auth exchange failed:', error.message);
          setStatus('Sign-in failed. Redirecting...');
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
