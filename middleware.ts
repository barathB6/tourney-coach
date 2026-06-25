import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Protect these paths — add more as needed
const protectedPaths = ['/profile', '/protected'];

export function middleware(req: NextRequest) {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  const isProtected = protectedPaths.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (!isProtected) return NextResponse.next();

  // Supabase stores the access token in sb-access-token cookie (client side)
  const token = req.cookies.get('sb-access-token')?.value || req.cookies.get('sb:token')?.value;

  if (!token) {
    const signInUrl = new URL('/sign-in', req.url);
    signInUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Optional: check JWT payload for a custom role claim (app_role)
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      // JWT payload is base64url; convert to base64
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = decodeURIComponent(
        Array.prototype.map
          .call(atob(padded), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const payload = JSON.parse(json);
      const appRole = payload['app_role'] || payload['role'];
      if (pathname.startsWith('/protected/admin') && appRole !== 'admin') {
        return NextResponse.redirect(new URL('/', req.url));
      }
    }
  } catch (e) {
    // ignore parse errors
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/profile', '/protected/:path*'],
};
