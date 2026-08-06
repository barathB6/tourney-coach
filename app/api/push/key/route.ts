import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// GET /api/push/key — the VAPID application server key, served at runtime.
//
// This exists because NEXT_PUBLIC_VAPID_PUBLIC_KEY does not survive the
// production build. It is marked "Sensitive" in Vercel, and sensitive variables
// are withheld at BUILD time — which is exactly when Next.js inlines
// NEXT_PUBLIC_* values into the bundle. So the client shipped
// `applicationServerKey: undefined`, pushManager.subscribe() threw, and the
// catch reported "Could not turn on notifications on this device."
// Web push had never worked in production, on any device, and the failure was
// indistinguishable from an unsupported browser.
//
// Serving it from here removes the build-time dependency entirely. That is the
// better shape regardless of the Vercel flag: a VAPID *public* key is public by
// definition — it is handed to every push service on every subscribe — so
// there is nothing to protect and no reason to bake it into a bundle at build
// time. The private key stays server-side and is never touched here.
export async function GET() {
  // Prefer the non-public variable: it is read at runtime, so it works whether
  // or not the NEXT_PUBLIC_ copy survived the build.
  const key = process.env.VAPID_PUBLIC_KEY?.trim() || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  if (!key) {
    return NextResponse.json(
      { error: 'Push is not configured on this deployment.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json({ key }, {
    // Safe to cache: it only changes when the key pair is rotated, and a stale
    // key fails loudly at subscribe time rather than silently.
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
