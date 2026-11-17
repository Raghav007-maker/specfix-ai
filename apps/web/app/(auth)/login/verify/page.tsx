import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { signOut, verifySecondFactor } from '@/app/(auth)/actions';
import { DEFAULTS, cssVars, dataAttrs } from '@/components/playground/settings';
import p from '@/components/playground/playground.module.css';

export const metadata: Metadata = { title: 'Enter your code · SpecFix' };

/**
 * The second sign-in step, for users with two-step verification on. It is the only page a
 * half-signed-in session can reach (getUser sends every other page here). Styled like the
 * sign-in page it follows.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [session, { error }] = await Promise.all([getSession(), searchParams]);
  if (!session) redirect('/login');
  if (!session.pending) redirect('/');

  const style = { ...cssVars(DEFAULTS), minHeight: '100vh' } as CSSProperties;
  return (
    <div
      className={p.root}
      data-pg-preview=""
      data-view="login"
      style={style}
      {...dataAttrs(DEFAULTS)}
    >
      <div className={p.view}>
        <div className={p.login} data-art="off">
          <main className={p.loginSide}>
            <form action={verifySecondFactor} className={p.loginForm}>
              <h1 className={p.loginTitle}>Enter your code</h1>
              <p className={p.muted}>
                Open your authenticator app (such as Google Authenticator) and enter the 6-digit
                code for SpecFix{session.user.email ? ` (${session.user.email})` : ''}.
              </p>
              <div className={p.field}>
                <label htmlFor="code">6-digit code</label>
                <input
                  id="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  maxLength={7}
                  required
                  autoFocus
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'code-err' : undefined}
                />
              </div>
              {error ? (
                <p className={`${p.note} ${p.noteErr}`} role="alert" id="code-err">
                  {error}
                </p>
              ) : null}
              <button type="submit" className={`${p.btn} ${p.btnSolid} ${p.btnBlock}`}>
                Verify
              </button>
              <p className={p.fine}>
                Lost your phone? Ask the SpecFix team to remove two-step verification from your
                account, then sign in and set it up again.
              </p>
            </form>
            <form action={signOut} style={{ textAlign: 'center' }}>
              <button type="submit" className={`${p.btn} ${p.btnGhost}`}>
                Sign out
              </button>
            </form>
          </main>
        </div>
      </div>
    </div>
  );
}
