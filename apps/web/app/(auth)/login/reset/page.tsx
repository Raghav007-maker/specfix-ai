import type { Metadata } from 'next';
import Link from 'next/link';
import { PASSWORD_MAX, PASSWORD_MIN } from '@specfix/shared';
import { setNewPassword } from '@/app/(auth)/actions';
import { AuthPanel, authStyles as p } from '@/components/auth-panel';
import { getRecoveryUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Choose a new password · SpecFix' };

/**
 * Where a password-reset email lands (through /auth/callback, which signs the person in for
 * the reset). Only a session opened from that link in the last 15 minutes gets the form; any
 * other visitor, signed in or not, is told how to get a new link.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [user, { error }] = await Promise.all([getRecoveryUser(), searchParams]);

  if (!user) {
    return (
      <AuthPanel>
        <div className={p.loginForm}>
          <h1 className={p.loginTitle}>Link expired</h1>
          <p className={p.muted}>
            This page opens from a password-reset email, for 15 minutes. That link has expired, was
            already used, or was opened in another browser.
          </p>
          <Link href="/login/forgot" className={`${p.btn} ${p.btnSolid} ${p.btnBlock}`}>
            Ask for a new link
          </Link>
        </div>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel>
      <form action={setNewPassword} className={p.loginForm}>
        <h1 className={p.loginTitle}>Choose a new password</h1>
        <p className={p.muted}>
          For {user.email ?? 'your account'}. Other devices signed in to this account will be signed
          out.
        </p>
        <div className={p.field}>
          <label htmlFor="password">New password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            required
            autoFocus
            aria-describedby="password-help"
          />
          <p className={p.help} id="password-help">
            {PASSWORD_MIN} to {PASSWORD_MAX} characters.
          </p>
        </div>
        <div className={p.field}>
          <label htmlFor="confirm">Type it again</label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'new-err' : undefined}
          />
        </div>
        {error ? (
          <p className={`${p.note} ${p.noteErr}`} role="alert" id="new-err">
            {error.slice(0, 200)}
          </p>
        ) : null}
        <button type="submit" className={`${p.btn} ${p.btnSolid} ${p.btnBlock}`}>
          Save new password
        </button>
      </form>
    </AuthPanel>
  );
}
