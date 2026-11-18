import 'server-only';

/** Whether "Continue with Google" is offered. Turn it on only after the Google provider is set
 * up in Supabase (Authentication → Sign In / Providers), or the button leads to an error page. */
export function googleSignInEnabled(): boolean {
  return process.env.GOOGLE_SIGN_IN_ENABLED?.trim() === '1';
}

/** Cloudflare Turnstile site key (public). Off when unset. Supabase must have CAPTCHA turned on
 * with the matching secret (Authentication → Attack Protection), or the token is ignored. */
export function captchaSiteKey(): string {
  return process.env.TURNSTILE_SITE_KEY?.trim() ?? '';
}

/** This app's own address, for links back to it (the OAuth return URL). Taken from the
 * environment, never from the request's Host header, which a client controls. */
export function appOrigin(): string {
  return (process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/$/, '');
}
