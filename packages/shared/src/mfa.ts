/**
 * Two-step verification (an authenticator app such as Google Authenticator), on top of
 * Supabase Auth's TOTP factors. Supabase stores the secrets and checks the codes; these are
 * the two small rules the web app applies around it.
 */

/**
 * Whether a signed-in session still owes its second step: the user has a verified factor, but
 * the session token is not yet at assurance level aal2. `factors` must come from the Auth
 * server's user record, never the session cookie's copy, which the browser can edit.
 * A missing or unknown `aal` counts as not verified.
 */
export function needsSecondFactor(
  aal: unknown,
  factors: readonly { status: string }[] | null | undefined
): boolean {
  return aal !== 'aal2' && (factors ?? []).some((f) => f.status === 'verified');
}

/** A 6-digit code as typed ("123 456", " 123456 "), or null when it is not one. */
export function normalizeTotpCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(code) ? code : null;
}
