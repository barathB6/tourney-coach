"use client"
import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import supabase from "../../lib/supabaseClient";

export default function SignInClient() {
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
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      router.push(next);
    } catch (err: any) {
      setMessage(err.message || "Sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: "2rem auto" }}>
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit}>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div style={{ marginTop: 12 }}>
          <button type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign in"}</button>
          <button type="button" onClick={() => router.push(`/sign-up?next=${next}`)} style={{ marginLeft: 8 }}>
            Sign up
          </button>
          <button type="button" onClick={() => router.push(`/forgot-password?next=${next}`)} style={{ marginLeft: 8 }}>
            Forgot?
          </button>
        </div>
      </form>
      {message && <p>{message}</p>}
    </div>
  );
}
