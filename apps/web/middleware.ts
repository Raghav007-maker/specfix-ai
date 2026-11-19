import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { contentSecurityPolicy } from '@/lib/csp';

export async function middleware(request: NextRequest) {
  // A fresh nonce per request: set on the request so Next.js stamps it on its own scripts while
  // rendering, and on the response so the browser enforces it.
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== 'production');
  request.headers.set('x-nonce', nonce);
  request.headers.set('Content-Security-Policy', csp);
  const response = await updateSession(request);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Run on every path except Next internals and static assets. Keeping the auth
  // cookie fresh on navigations is the whole job; static files never carry a session,
  // so excluding them by extension avoids a needless auth round-trip per asset. Page
  // and API routes do not end in these extensions, so none of them are exempted —
  // except the machine endpoints (GitHub and Razorpay webhooks, CI results): they authenticate with
  // their own token and never carry a session, so refreshing one would only cost a
  // Supabase round-trip per delivery.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/github/webhook|api/ci/results|api/payments/razorpay/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|woff|woff2|ttf|otf|map)$).*)',
  ],
};
