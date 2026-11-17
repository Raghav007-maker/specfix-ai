import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Where Google sign-in returns. Supabase hands back a one-time `code`, exchanged here for the
 * session cookie (the PKCE verifier set when the sign-in started must match). The redirect
 * target is fixed, never taken from the request, so this cannot be used as an open redirect.
 * A user with two-step verification on then lands on /login/verify via getUser.
 */
export async function GET(request: NextRequest) {
  const failed = () =>
    NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent('Google sign-in did not finish. Please try again.')}`,
        request.url
      )
    );

  const code = request.nextUrl.searchParams.get('code');
  if (!code || code.length > 512) {
    const reason = request.nextUrl.searchParams.get('error_description');
    if (reason) console.error('[auth] Google sign-in returned an error:', reason.slice(0, 200));
    return failed();
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('[auth] Google code exchange failed:', error.name, error.status ?? 0);
      return failed();
    }
  } catch (err) {
    console.error('[auth] Google code exchange threw:', err instanceof Error ? err.message : err);
    return failed();
  }
  return NextResponse.redirect(new URL('/', request.url));
}
