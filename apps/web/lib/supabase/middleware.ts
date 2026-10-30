import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options: CookieOptions };

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

  await supabase.auth.getClaims();

  return response;
}
