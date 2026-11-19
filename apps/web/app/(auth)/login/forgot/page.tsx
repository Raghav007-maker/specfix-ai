import type { Metadata } from 'next';
import Link from 'next/link';
import { requestPasswordReset } from '@/app/(auth)/actions';
import { AuthPanel, authStyles as p } from '@/components/auth-panel';
import { Turnstile } from '@/components/playground/turnstile';
import { captchaSiteKey } from '@/lib/auth';

export const metadata: Metadata = { title: 'Reset your password · SpecFix' };

/** "Forgot password": enter the sign-in email and get a reset link. */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;
  const siteKey = captchaSiteKey();
  return (
    <AuthPanel>
      <form action={requestPasswordReset} className={p.loginForm}>
        <h1 className={p.loginTitle}>Reset your password</h1>
        <p className={p.muted}>
          Enter the email you sign in with. We will send a link to choose a new password.
        </p>
        <div className={p.field}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@company.com"
            maxLength={254}
            required
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'reset-err' : undefined}
          />
        </div>
        {error ? (
          <p className={`${p.note} ${p.noteErr}`} role="alert" id="reset-err">
            {error.slice(0, 200)}
          </p>
        ) : null}
        {message ? (
          <p className={`${p.note} ${p.noteOk}`} role="status">
            {message.slice(0, 200)}
          </p>
        ) : null}
        {siteKey ? <Turnstile siteKey={siteKey} /> : null}
        <button type="submit" className={`${p.btn} ${p.btnSolid} ${p.btnBlock}`}>
          Send reset link
        </button>
        <p className={p.fine}>
          Remembered it? <Link href="/login">Back to sign in</Link>
        </p>
      </form>
    </AuthPanel>
  );
}
