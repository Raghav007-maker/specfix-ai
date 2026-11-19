import type { NextRequest } from 'next/server';
import { callbackTarget } from '@specfix/shared';
import { createClient } from '@/lib/supabase/server';
import { redirectTo } from '@/lib/redirect';

/**
 * Where Supabase sends people back: after Google sign-in, and from a password-reset email
 * (`?next=reset`). Supabase hands back a one-time `code`, exchanged here for the session cookie
 * (the PKCE verifier set when the flow started, in this same browser, must match). The redirect
 * target comes from a fixed list (callbackTarget), never from the request, so this cannot be
 * used as an open redirect. A user with two-step verification on then lands on /login/verify
 * via getUser.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const target = callbackTarget(params.get('next'));
  const reset = target === '/login/reset';
  const failed = () =>
    reset
      ? redirectTo(
          `/login/forgot?error=${encodeURIComponent(
            'That reset link has expired, was already used, or was opened in another browser. Ask for a new one.'
          )}`
        )
      : redirectTo(
          `/login?error=${encodeURIComponent('Google sign-in did not finish. Please try again.')}`
        );

  const code = params.get('code');
  if (!code || code.length > 512) {
    const reason = params.get('error_description');
    if (reason) console.error('[auth] callback returned an error:', reason.slice(0, 200));
    return failed();
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('[auth] code exchange failed:', error.name, error.status ?? 0);
      return failed();
    }
  } catch (err) {
    console.error('[auth] code exchange threw:', err instanceof Error ? err.message : err);
    return failed();
  }
  return redirectTo(target);
}
