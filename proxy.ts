import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const protectedPaths = ['/dashboard', '/profile', '/protected'];

export function proxy(request: NextRequest) {
  const { nextUrl } = request;
  const hostname = request.headers.get('host')?.split(':')[0] ?? '';

  // Subdomain detection
  const isMainDomain =
    hostname === 'tourneycoach.com' ||
    hostname === 'www.tourneycoach.com' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.vercel.app');

  if (!isMainDomain) {
    // e.g. green-valley-open.tourneycoach.com → slug = 'green-valley-open'
    const slug = hostname.split('.')[0];
    const rewriteUrl = nextUrl.clone();
    rewriteUrl.pathname = `/microsite/${slug}${nextUrl.pathname === '/' ? '' : nextUrl.pathname}`;
    return NextResponse.rewrite(rewriteUrl);
  }

  // Auth guard for protected paths
  const pathname = nextUrl.pathname;
  const isProtected = protectedPaths.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );

  if (isProtected) {
    const token =
      request.cookies.get('sb-access-token')?.value ||
      request.cookies.get('sb:token')?.value;

    if (!token) {
      const signInUrl = new URL('/sign-in', request.url);
      signInUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(signInUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
