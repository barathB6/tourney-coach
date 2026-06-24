"use client"
import React, { useEffect, useState } from "react";
import supabase from "../../lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
  const [user, setUser] = useState<any | null>(null);
  const [profile, setProfile] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data?.user) {
        router.push(`/sign-in?next=/profile`);
        return;
      }
      setUser(data.user);

      try {
        const { data: p } = await supabase.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
        setProfile(p ?? null);
      } catch (e) {
        // ignore
      }
      setLoading(false);
    })();
  }, [router]);

  if (loading) return <p>Loading...</p>;
  if (!user) return <p>Not signed in</p>;

  return (
    <div style={{ maxWidth: 640, margin: "2rem auto" }}>
      <h1>Profile</h1>
      <p><strong>Name:</strong> {profile?.name ?? user.user_metadata?.full_name ?? "—"}</p>
      <p><strong>Email:</strong> {user.email}</p>
      <p><strong>Phone:</strong> {profile?.phone ?? user.user_metadata?.phone ?? "—"}</p>
      <p><strong>Role:</strong> {profile?.role ?? user.user_metadata?.role ?? "user"}</p>
      <div style={{ marginTop: 12 }}>
        <button onClick={async () => { await supabase.auth.signOut(); router.push('/'); }}>Sign out</button>
      </div>
    </div>
  );
}
