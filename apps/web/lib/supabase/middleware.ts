import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options: CookieOptions };

/** Pages that need a session. Their own checks stay; this only answers a visitor without one
 * with a real 307 before any rendering, instead of a streamed 200 that redirects in the browser. */
const SIGNED_IN_ONLY =
  /^\/(?:admin|analytics|calendar|inbox|onboarding|pricing|projects|search|settings|team|tickets|login\/verify)(?:\/|$)/;

export function needsSession(pathname: string): boolean {
  return SIGNED_IN_ONLY.test(pathname);
}

/**
 * Refreshes the Supabase auth session on every request and rewrites the session
 * cookie onto the response. This runs in the Edge middleware, so it touches only
 * @supabase/ssr and next/server — never pg or any Node-only code.
 *
 * The ordering here matters: create the client, then immediately call getClaims(),
 * with no logic in between. getClaims() is what refreshes an expired token; anything
 * that reads cookies before it can act on a stale session.
 *
 * getClaims() verifies the token locally against the project's cached ES256 public key,
 * so a navigation no longer waits on an Auth-server round trip here (getUser() cost
 * 0.3–1 s per request). Pages still call getUser() (lib/session.ts) for the full user.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  const { data } = await supabase.auth.getClaims();

  if (!data?.claims && needsSession(request.nextUrl.pathname)) {
    // Middleware needs an absolute Location; request.url's origin is the bind address behind
    // Azure's proxy, so build it from the Host the browser sent (Azure only routes its own hosts).
    const host = request.headers.get('host');
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    // A visitor who follows a link without a session sees the landing page, not a bare login
    // form; only the second sign-in step goes straight to /login.
    const target = request.nextUrl.pathname.startsWith('/login') ? '/login' : '/';
    const toLogin = NextResponse.redirect(
      host ? new URL(target, `${proto}://${host}`) : new URL(target, request.url)
    );
    // Carry any cookie the refresh just cleared, so a dead session does not linger.
    for (const cookie of response.cookies.getAll()) toLogin.cookies.set(cookie);
    return toLogin;
  }
  return response;
}
