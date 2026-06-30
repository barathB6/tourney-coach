"use client";
import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import supabase from "../../lib/supabaseClient";

interface UserProfile {
  name: string;
  email: string;
  avatar: string;
}

export default function SignInClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUser({
          name: user.user_metadata?.full_name || user.email || '',
          email: user.email || '',
          avatar: user.user_metadata?.avatar_url || '',
        });
      }
      setChecking(false);
    });
  }, []);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--cream)' }}>
        <p className="text-sm" style={{ color: 'var(--ink)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--cream)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: 'var(--deep-green)' }}>TourneyCoach</h1>
          <p className="mt-2" style={{ color: 'var(--ink)', opacity: 0.6 }}>
            {user ? 'Welcome back' : 'Sign in to get started'}
          </p>
        </div>

        <div className="rounded-xl shadow-lg p-8" style={{ background: 'white', border: '1px solid var(--line)' }}>
          {user ? (
            <div className="flex flex-col items-center gap-4">
              {user.avatar && (
                <img
                  src={user.avatar}
                  alt={user.name}
                  className="w-16 h-16 rounded-full"
                  style={{ border: '3px solid var(--primary)' }}
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="text-center">
                <p className="text-lg font-bold" style={{ color: 'var(--ink)' }}>{user.name}</p>
                <p className="text-sm" style={{ color: 'var(--ink)', opacity: 0.5 }}>{user.email}</p>
              </div>
              <button
                onClick={() => router.push('/dashboard')}
                className="w-full px-4 py-3 rounded-lg text-white font-medium transition-colors"
                style={{ background: 'linear-gradient(180deg, var(--primary), var(--deep-green))' }}
              >
                Continue to TourneyCoach →
              </button>
              <button
                onClick={handleSignOut}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ color: 'var(--ink)', border: '1px solid var(--line)' }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={handleGoogleSignIn}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-lg font-medium disabled:opacity-50 transition-colors"
                style={{ border: '1px solid var(--line)', color: 'var(--ink)' }}
              >
                <svg width="20" height="20" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24.01 24.01 0 0 0 0 21.56l7.98-6.19z" />
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                </svg>
                {loading ? "Redirecting..." : "Sign in with Google"}
              </button>
              {error && (
                <p className="mt-4 text-sm text-center" style={{ color: 'var(--alert)' }}>{error}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
