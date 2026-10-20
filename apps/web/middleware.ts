import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on every path except Next internals and static assets. Keeping the auth
  // cookie fresh on navigations is the whole job; static files never carry a session,
  // so excluding them by extension avoids a needless auth round-trip per asset. Page
  // and API routes do not end in these extensions, so none of them are exempted.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|woff|woff2|ttf|otf|map)$).*)',
  ],
};
