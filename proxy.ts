import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const { nextUrl } = request;
  const hostname = request.headers.get('host')?.split(':')[0] ?? '';

  // Subdomain routing: eventname.tourneycoach.com → /microsite/[slug]
  const isMainDomain =
    hostname === 'tourneycoach.com' ||
    hostname === 'www.tourneycoach.com' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.vercel.app');

  if (!isMainDomain) {
    const slug = hostname.split('.')[0];
    const rewriteUrl = nextUrl.clone();
    rewriteUrl.pathname = `/microsite/${slug}${nextUrl.pathname === '/' ? '' : nextUrl.pathname}`;
    return NextResponse.rewrite(rewriteUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
