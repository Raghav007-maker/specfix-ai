'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthError } from '@supabase/supabase-js';
import { newPasswordProblem, normalizeTotpCode, resetEmailOk } from '@specfix/shared';
import { RateLimiter } from '@/lib/repos';
import { createClient } from '@/lib/supabase/server';
import { forgetUser, getRecoveryUser, getSession } from '@/lib/session';
import { appOrigin, captchaSiteKey, googleSignInEnabled } from '@/lib/auth';

const TOO_MANY = 'Too many attempts. Please wait a few minutes and try again.';

// Shared by every server through Postgres (migration 0025).
const signInByIp = new RateLimiter('signin-ip', 20, 15 * 60_000);
const signInByEmail = new RateLimiter('signin-email', 10, 15 * 60_000);
const signUpByIp = new RateLimiter('signup-ip', 5, 60 * 60_000);
// Six digits are a million guesses; five tries per quarter hour keeps guessing hopeless.
const secondStepByUser = new RateLimiter('2fa-user', 5, 15 * 60_000);
const secondStepByIp = new RateLimiter('2fa-ip', 20, 15 * 60_000);
// Each reset request sends an email: few per address, a few more per network.
const resetByEmail = new RateLimiter('reset-email', 3, 60 * 60_000);
const resetByIp = new RateLimiter('reset-ip', 10, 60 * 60_000);
const newPasswordByUser = new RateLimiter('new-password-user', 5, 15 * 60_000);

/** Emails over 254 chars are invalid; Supabase rejects passwords over 72. Refused without a call. */
const tooLong = (email: string, password: string) => email.length > 254 || password.length > 72;

/**
 * The Turnstile token the form carries, as Supabase's `captchaToken` option. Undefined when the
 * check is off; when it is on but the form has no token, the caller is sent back without a call.
 */
function captchaOptions(formData: FormData): { captchaToken?: string } | null {
  if (!captchaSiteKey()) return {};
  const token = String(formData.get('cf-turnstile-response') ?? '');
  return token && token.length <= 4096 ? { captchaToken: token } : null;
}

const NO_CAPTCHA = 'Please complete the human check and try again.';

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
  // Supabase refused the human check (expired, reused or from the wrong site key).
  if (error.code === 'captcha_failed' || /captcha/i.test(error.message)) return NO_CAPTCHA;
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

  const captcha = captchaOptions(formData);
  let reason: string | null = null;
  if (tooLong(email, password)) {
    reason = 'Incorrect email or password.';
  } else if (!captcha) {
    reason = NO_CAPTCHA;
  } else if (!(
    (await signInByIp.take(await clientIp())) && (await signInByEmail.take(email.toLowerCase()))
  )) {
    reason = TOO_MANY;
  } else {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: captcha,
      });
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
  const captcha = captchaOptions(formData);
  if (!captcha) redirect(`/login?mode=sign-up&error=${encodeURIComponent(NO_CAPTCHA)}`);
  if (!(await signUpByIp.take(await clientIp())))
    redirect(`/login?error=${encodeURIComponent(TOO_MANY)}`);

  let destination = '/';
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({ email, password, options: captcha });
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

/**
 * The second sign-in step: the 6-digit code from the user's authenticator app. Supabase checks
 * it and raises the session to aal2; until then getUser sends every page here.
 */
export async function verifySecondFactor(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.pending) redirect('/');
  const back = (message: string): never =>
    redirect(`/login/verify?error=${encodeURIComponent(message)}`);

  const code = normalizeTotpCode(formData.get('code'));
  if (!code) return back('Enter the 6-digit code from your authenticator app.');
  if (!(
    (await secondStepByUser.take(session.user.id)) && (await secondStepByIp.take(await clientIp()))
  )) {
    back(TOO_MANY);
  }
  const factor = session.user.factors?.find(
    (f) => f.factor_type === 'totp' && f.status === 'verified'
  );
  if (!factor) redirect('/');

  let verified = false;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) console.error('[auth] second step failed:', error.name, error.status ?? 0);
    else verified = true;
  } catch (err) {
    console.error('[auth] second step threw:', err instanceof Error ? err.message : err);
  }
  if (!verified) {
    back('That code did not work. Use the newest code, and check the time on your phone is right.');
  }
  redirect('/');
}

/**
 * "Continue with Google": Supabase sends the browser to Google and back to /auth/callback,
 * which finishes the sign-in. Off unless GOOGLE_SIGN_IN_ENABLED=1, because the Google provider
 * has to be set up in the Supabase dashboard first.
 */
export async function signInWithGoogle(): Promise<void> {
  if (!googleSignInEnabled()) {
    redirect(`/login?error=${encodeURIComponent('Google sign-in is not available yet.')}`);
  }
  let url: string | null = null;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${appOrigin()}/auth/callback` },
    });
    if (error) console.error('[auth] Google sign-in failed:', error.name, error.status ?? 0);
    else url = data.url;
  } catch (err) {
    console.error('[auth] Google sign-in threw:', err instanceof Error ? err.message : err);
  }
  if (!url) {
    redirect(
      `/login?error=${encodeURIComponent('Could not start Google sign-in. Please try again.')}`
    );
  }
  redirect(url);
}

/** The same answer whether or not an account exists, so this page cannot tell who has one. */
const RESET_SENT =
  'If an account uses that email, a reset link is on its way. Open it in this browser.';

/**
 * "Forgot password": asks Supabase to email a reset link. The link comes back to this app's own
 * /auth/callback (PUBLIC_BASE_URL, never the request's Host), which signs the person in for
 * the reset and opens /login/reset. Supabase uses that address only if it is on the project's
 * Redirect URLs list; otherwise it falls back to the Site URL.
 */
export async function requestPasswordReset(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const back = (key: 'error' | 'message', text: string): never =>
    redirect(`/login/forgot?${key}=${encodeURIComponent(text)}`);

  if (!resetEmailOk(email)) back('error', 'Enter the email you sign in with.');
  const captcha = captchaOptions(formData);
  if (!captcha) back('error', NO_CAPTCHA);
  if (!((await resetByIp.take(await clientIp())) && (await resetByEmail.take(email)))) {
    back('error', TOO_MANY);
  }

  let failed: string | null = null;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appOrigin()}/auth/callback?next=reset`,
      ...captcha,
    });
    if (error) {
      console.error('[auth] reset request failed:', error.name, error.status ?? 0, error.message);
      // An unknown email is not an error to the visitor; transport and rate problems are.
      if (error.name === 'AuthRetryableFetchError' || !error.status) {
        failed = 'Cannot reach the authentication server. Please try again.';
      } else if (error.status === 429) {
        failed = TOO_MANY;
      } else if (error.code === 'captcha_failed' || /captcha/i.test(error.message)) {
        failed = NO_CAPTCHA;
      }
    }
  } catch (err) {
    console.error('[auth] reset request threw:', err instanceof Error ? err.message : err);
    failed = 'Something went wrong. Please try again.';
  }
  if (failed) back('error', failed);
  back('message', RESET_SENT);
}

/**
 * Sets a new password for the person the reset link signed in. Other sessions of the account
 * are signed out, so whoever knew the old password loses access.
 */
export async function setNewPassword(formData: FormData): Promise<void> {
  const user = await getRecoveryUser();
  if (!user) {
    redirect(
      `/login/forgot?error=${encodeURIComponent('That reset link has expired. Ask for a new one.')}`
    );
  }
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const back = (text: string): never => redirect(`/login/reset?error=${encodeURIComponent(text)}`);

  const problem = newPasswordProblem(password, confirm);
  if (problem) back(problem);
  if (!(await newPasswordByUser.take(user.id))) back(TOO_MANY);

  let failed: string | null = null;
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.error('[auth] password update failed:', error.name, error.status ?? 0, error.code);
      failed =
        error.code === 'same_password'
          ? 'Choose a password different from your old one.'
          : error.code === 'weak_password'
            ? 'That password is too weak. Try a longer one.'
            : error.status === 429
              ? TOO_MANY
              : 'Could not change the password. Ask for a new reset link and try again.';
    } else {
      await supabase.auth.signOut({ scope: 'others' });
    }
  } catch (err) {
    console.error('[auth] password update threw:', err instanceof Error ? err.message : err);
    failed = 'Something went wrong. Please try again.';
  }
  if (failed) back(failed);
  forgetUser(user.id);
  // A user with two-step verification still enters their code next (getUser sends them there).
  redirect('/');
}
