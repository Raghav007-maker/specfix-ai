/**
 * Pure rules for the "forgot password" flow, shared by the server actions and their tests.
 */

/** Supabase's own floor and bcrypt's ceiling: longer passwords are cut silently, so refuse them. */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;

/** Why a new password cannot be used, or null when it can. */
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.trim().length === 0) return 'The password cannot be only spaces.';
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

/** A plausible email to send a reset link to: one @, something either side, no spaces. */
export function resetEmailOk(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Where the auth callback sends someone after it trades the one-time code for a session. Only
 * known values map anywhere special; anything else (or a path someone typed in) goes home, so
 * the callback is never an open redirect.
 */
export function callbackTarget(next: string | null): '/login/reset' | '/' {
  return next === 'reset' ? '/login/reset' : '/';
}

/** How long after opening the reset link the new-password form stays usable. */
export const RECOVERY_WINDOW_SEC = 15 * 60;

/**
 * Whether this session came from a password-reset link opened in the last 15 minutes, read
 * from the session token's `amr` claim. A session signed in with a password does not qualify,
 * so a borrowed, already-open laptop cannot be used to change the password without the old one.
 */
export function recoveryIsFresh(
  amr: unknown,
  nowSec: number,
  windowSec: number = RECOVERY_WINDOW_SEC
): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return (
      method === 'recovery' &&
      typeof timestamp === 'number' &&
      timestamp <= nowSec + 60 &&
      nowSec - timestamp <= windowSec
    );
  });
}
