'use server';

import { redirect } from 'next/navigation';
import { normalizeTotpCode } from '@specfix/shared';
import { RateLimiter } from '@/lib/repos';
import { createClient } from '@/lib/supabase/server';
import { forgetUser, requireUser } from '@/lib/session';

/**
 * Two-step verification settings. Supabase Auth keeps the authenticator secret and checks every
 * code; these actions only drive its MFA API for the signed-in user. requireUser already refuses
 * a session that owes its second step, so turning 2FA off needs a fully signed-in session and,
 * on top, a fresh code.
 */

// Shared by every server through Postgres (migration 0025).
const codesByUser = new RateLimiter('2fa-setup', 5, 15 * 60_000);

export type TotpSetup =
  | { status: 'ready'; factorId: string; qr: string; secret: string }
  | { status: 'error'; error: string };

function back(outcome: { error: string } | { notice: string }): never {
  redirect(`/settings/security?${new URLSearchParams(outcome).toString()}`);
}

/**
 * Starts setting up an authenticator app: a new, unconfirmed factor and its QR code. Any earlier
 * unconfirmed attempt is dropped first, so abandoning setup leaves nothing behind.
 */
export async function startTotpSetup(): Promise<TotpSetup> {
  await requireUser();
  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) return { status: 'error', error: 'Could not start setup. Please try again.' };
  if (listed.data.totp.some((f) => f.status === 'verified')) {
    return { status: 'error', error: 'Two-step verification is already on.' };
  }
  for (const stale of listed.data.all.filter((f) => f.status === 'unverified')) {
    await supabase.auth.mfa.unenroll({ factorId: stale.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Authenticator app',
    issuer: 'SpecFix',
  });
  if (error) {
    console.error('[security] enroll failed:', error.name, error.status ?? 0);
    return { status: 'error', error: 'Could not start setup. Please try again.' };
  }
  const svg = data.totp.qr_code;
  return {
    status: 'ready',
    factorId: data.id,
    qr: svg.startsWith('data:') ? svg : `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    secret: data.totp.secret,
  };
}

/** Confirms setup with the first code from the app; from then on sign-in asks for a code. */
export async function confirmTotpSetup(formData: FormData): Promise<void> {
  const user = await requireUser();
  const factorId = String(formData.get('factorId') ?? '');
  const code = normalizeTotpCode(formData.get('code'));
  if (!code) back({ error: 'Enter the 6-digit code your app shows for SpecFix.' });
  if (!(await codesByUser.take(user.id))) back({ error: 'Too many attempts. Wait a few minutes.' });

  const supabase = await createClient();
  // Only a factor of this user can be confirmed; Supabase scopes the call to the session.
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) {
    back({ error: 'That code did not work. Start setup again and use the newest code.' });
  }
  forgetUser(user.id);
  back({ notice: 'Two-step verification is on. Sign-ins now ask for a code from your app.' });
}

/** Turns two-step verification off; needs a current code from the app. */
export async function disableTotp(formData: FormData): Promise<void> {
  const user = await requireUser();
  const code = normalizeTotpCode(formData.get('code'));
  if (!code) back({ error: 'Enter the current 6-digit code to turn this off.' });
  if (!(await codesByUser.take(user.id))) back({ error: 'Too many attempts. Wait a few minutes.' });

  const supabase = await createClient();
  const listed = await supabase.auth.mfa.listFactors();
  const factor = listed.data?.totp.find((f) => f.status === 'verified');
  if (!factor) back({ notice: 'Two-step verification is already off.' });

  const checked = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (checked.error) back({ error: 'That code did not work. Use the newest code from your app.' });
  const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
  if (removed.error) {
    console.error('[security] unenroll failed:', removed.error.name, removed.error.status ?? 0);
    back({ error: 'Could not turn it off. Please try again.' });
  }
  forgetUser(user.id);
  back({ notice: 'Two-step verification is off.' });
}
