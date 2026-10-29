'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthError } from '@supabase/supabase-js';
import { AttemptLimiter } from '@specfix/shared';
import { createClient } from '@/lib/supabase/server';

const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.';

// shortcut: counters live in this server process; with several instances, move them to Postgres.
const signInByIp = new AttemptLimiter(20, 15 * 60_000);
const signInByEmail = new AttemptLimiter(10, 15 * 60_000);
const signUpByIp = new AttemptLimiter(5, 60 * 60_000);

/** Emails over 254 chars are invalid; Supabase rejects passwords over 72. Refused without a call. */
const tooLong = (email: string, password: string) => email.length > 254 || password.length > 72;

/** The caller's IP, as set by the proxy in front (Vercel, nginx). A server exposed directly
 * lets clients spoof these headers, so the per-email limit is what still holds then. */
async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get('x-real-ip') ?? (h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown');
}

/**
 * Turn a Supabase AuthError into a message that is safe to show a user.
 *
 * Two cases are easy to confuse and must not be:
 *  - The request never reached the auth server (offline, DNS, firewall, or a paused
 *    project). The SDK surfaces this as a retryable fetch error with no HTTP status —
 *    "fetch failed" is a transport message, NOT a verdict on the credentials. Reporting
 *    "wrong password" here would be a lie, which is exactly the confusing behaviour we
 *    are fixing.
 *  - The server answered and rejected the input (400 / 401 / 422).
 * Everything else gets a neutral message. Raw SDK or provider text is never shown to the
 * user; it is logged server-side instead.
 */
function friendlyAuthMessage(error: AuthError, action: 'sign-in' | 'sign-up'): string {
  const status = error.status ?? 0;

  if (error.name === 'AuthRetryableFetchError' || status === 0) {
    return 'Cannot reach the authentication server. Please check your connection and try again.';
  }
  if (status === 429) return TOO_MANY;
  if (action === 'sign-in' && (status === 400 || status === 401)) {
    return 'Incorrect email or password.';
  }
  if (action === 'sign-up' && (status === 400 || status === 422)) {
    return 'Could not create the account. The email may already be in use, or the password is too weak.';
  }
  return action === 'sign-in'
    ? 'Could not sign you in. Please try again.'
    : 'Could not create the account. Please try again.';
}

/** Sign in with email + password. On failure, bounce back to /login with a safe reason. */
export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  let reason: string | null = null;
  if (tooLong(email, password)) {
    reason = 'Incorrect email or password.';
  } else if (!(signInByIp.take(await clientIp()) && signInByEmail.take(email.toLowerCase()))) {
    reason = TOO_MANY;
  } else {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Server-side diagnostics: enough to debug, with no email or password in the log.
        console.error('[auth] sign-in failed:', error.name, error.status ?? 0, error.message);
        reason = friendlyAuthMessage(error, 'sign-in');
      }
    } catch (err) {
      console.error('[auth] sign-in threw:', err instanceof Error ? err.message : err);
      reason = 'Something went wrong signing you in. Please try again.';
    }
  }

  // redirect() works by throwing, so it must run outside the try/catch above or the
  // catch would swallow the redirect itself.
  if (reason) redirect(`/login?error=${encodeURIComponent(reason)}`);
  redirect('/');
}

/**
 * Create an account. Whether a session is returned depends on the Supabase project's
 * email-confirmation setting: with confirmations on, the user must click a link
 * before they can sign in, so we send them back with a notice rather than to a
 * dashboard they cannot yet load.
 */
export async function signUp(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (tooLong(email, password)) {
    redirect(`/login?error=${encodeURIComponent('Use a shorter email or password.')}`);
  }
  if (!signUpByIp.take(await clientIp())) redirect(`/login?error=${encodeURIComponent(TOO_MANY)}`);

  let destination = '/';
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      console.error('[auth] sign-up failed:', error.name, error.status ?? 0, error.message);
      destination = `/login?error=${encodeURIComponent(friendlyAuthMessage(error, 'sign-up'))}`;
    } else if (!data.session) {
      destination =
        '/login?message=' +
        encodeURIComponent('Account created — check your email to confirm, then sign in.');
    }
  } catch (err) {
    console.error('[auth] sign-up threw:', err instanceof Error ? err.message : err);
    destination = `/login?error=${encodeURIComponent('Something went wrong. Please try again.')}`;
  }

  redirect(destination);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
