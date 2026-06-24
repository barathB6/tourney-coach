"use client"
import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import supabase from "../../lib/supabaseClient";

export default function SignUpPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams?.get("next") || "/profile";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const redirectTo = (process.env.NEXT_PUBLIC_APP_URL || "") + next;
      const { data, error } = await supabase.auth.signUp({ email, password }, { redirectTo });
      if (error) throw error;

      // Optionally create profiles row if the table exists
      try {
        const userId = data?.user?.id;
        if (userId) {
          await supabase.from("profiles").insert({ id: userId, name: null, phone: null, role: 'user' });
        }
      } catch (e) {
        // ignore
      }

      setMessage("You're almost done — check your email for a confirmation link.");
    } catch (err: any) {
      setMessage(err?.message || "Sign-up failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-hero">
        <h1>A trophy is a story.</h1>
        <p className="hint">Create an account to start organizing. We'll guide you through the next steps.</p>
      </div>

      <form onSubmit={handleSubmit} aria-label="Sign up form">
        <div className="form-row">
          <label htmlFor="email">Email</label>
          <input id="email" className="form-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>

        <div className="form-row">
          <label htmlFor="password">Password</label>
          <input id="password" className="form-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </div>

        <div className="form-actions">
          <button className="primary-btn" type="submit" disabled={loading}>{loading ? 'Creating account…' : 'Create account'}</button>
          <button type="button" className="secondary-btn" onClick={() => router.push(`/sign-in?next=${next}`)}>Sign in</button>
        </div>
      </form>

      {message && <div className="message" role="status">{message}</div>}
    </div>
  );
}
