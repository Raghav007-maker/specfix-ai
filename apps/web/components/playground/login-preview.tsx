'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { signIn, signUp } from '@/app/(auth)/actions';
import type { Settings } from './settings';
import { Logo } from './logo';
import { ParticleFigure } from './particles';
import s from './playground.module.css';

export type AuthMode = 'sign-in' | 'sign-up';

// The real messages the auth actions redirect with, so the state previews show true copy.
const SAMPLE_ERROR = 'Incorrect email or password.';
const SAMPLE_NOTICE = 'Account created — check your email to confirm, then sign in.';

/**
 * The sign-in screen in the landing page's language. The form posts to the existing `signIn`
 * and `signUp` server actions with the same `email` and `password` fields, so a real submit
 * signs in (or redirects back to /login with the action's own message) exactly as production
 * does. The "preview state" control only changes what this preview displays; it never submits.
 */
export function LoginPreview({
  settings,
  mode,
  setMode,
  goHome,
  error,
  message,
}: {
  settings: Settings;
  mode: AuthMode;
  setMode: (m: AuthMode) => void;
  goHome: () => void;
  /** The auth actions' own `?error=` / `?message=` text, on the real sign-in page. */
  error?: string;
  message?: string;
}) {
  const b = settings.brand;
  const state = settings.tweaks.loginState;
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const validate = (e: FormEvent<HTMLFormElement>) => {
    const email = emailRef.current;
    const password = passwordRef.current;
    const next: typeof errors = {};
    if (!email?.value.trim()) next.email = 'Enter your work email.';
    else if (email.validity.typeMismatch)
      next.email = 'That doesn’t look like an email address. Check for a missing @ or domain.';
    if (!password?.value) next.password = 'Enter your password.';
    else if (password.value.length < 6) next.password = 'Use at least 6 characters.';
    setErrors(next);
    if (next.email || next.password) {
      e.preventDefault();
      (next.email ? email : password)?.focus();
    }
  };

  const shownError = error ?? (state === 'error' ? SAMPLE_ERROR : null);
  const shownNotice = message ?? (state === 'notice' ? SAMPLE_NOTICE : null);
  const title = mode === 'sign-in' ? 'Sign in to SpecFix' : 'Create your SpecFix account';

  return (
    <div className={s.login} data-art={settings.tweaks.artPanel ? 'on' : 'off'}>
      {settings.tweaks.artPanel ? (
        <section className={s.loginArt} aria-label="About SpecFix">
          <Logo
            variant={b.logoVariant}
            size={b.logoSize}
            animation={b.logoAnimation}
            loop={b.logoLoop}
          />
          {settings.tweaks.particles ? (
            <ParticleFigure
              className={s.loginFigure}
              speed={b.motionSpeed}
              intensity={b.intensity / 100}
              density={b.dotDensity / 100}
              label="Animated dot figure. Decorative; click to change its form."
            />
          ) : (
            <div className={s.loginFigure} aria-hidden="true" />
          )}
          <div className={s.loginCaption}>
            <p className={s.display}>
              <span>Review the ticket</span>{' '}
              <span className={s.voice}>before anyone builds it.</span>
            </p>
            <p className={s.muted}>
              Write your own gaps first, then see what the model found. Every flag ends as a
              decision in the audit trail.
            </p>
          </div>
        </section>
      ) : null}

      <main className={s.loginSide}>
        <button type="button" className={s.back} onClick={goHome}>
          <ArrowLeft aria-hidden size={16} strokeWidth={1.75} /> Back to SpecFix
        </button>

        <form
          className={s.loginForm}
          noValidate
          onSubmit={validate}
          aria-describedby={`${id}-fine`}
        >
          {!settings.tweaks.artPanel ? (
            <Logo
              variant={b.logoVariant}
              size={b.logoSize}
              animation={b.logoAnimation}
              loop={b.logoLoop}
              className={s.loginLogo}
            />
          ) : null}
          <h1 className={s.loginTitle}>{title}</h1>
          <p className={s.muted}>Use the email your workspace invited.</p>

          <div className={s.modeSwitch} role="radiogroup" aria-label="What do you want to do?">
            {(['sign-in', 'sign-up'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => {
                  setMode(m);
                  setErrors({});
                }}
              >
                {m === 'sign-in' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <div className={s.field} data-invalid={errors.email ? 'true' : undefined}>
            <label htmlFor={`${id}-email`}>Email</label>
            <input
              ref={emailRef}
              id={`${id}-email`}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              required
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? `${id}-email-err` : undefined}
              onInput={() => errors.email && setErrors({ ...errors, email: undefined })}
            />
            {errors.email ? (
              <p className={s.fieldErr} id={`${id}-email-err`}>
                {errors.email}
              </p>
            ) : null}
          </div>

          <div className={s.field} data-invalid={errors.password ? 'true' : undefined}>
            <label htmlFor={`${id}-password`}>Password</label>
            <div className={s.fieldBox}>
              <input
                ref={passwordRef}
                id={`${id}-password`}
                name="password"
                type={show ? 'text' : 'password'}
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                required
                minLength={6}
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={`${errors.password ? `${id}-password-err ` : ''}${id}-password-help`}
                onInput={() => errors.password && setErrors({ ...errors, password: undefined })}
              />
              <button
                type="button"
                className={s.eye}
                aria-controls={`${id}-password`}
                aria-pressed={show}
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
              </button>
            </div>
            {errors.password ? (
              <p className={s.fieldErr} id={`${id}-password-err`}>
                {errors.password}
              </p>
            ) : null}
            <p className={s.help} id={`${id}-password-help`}>
              At least 6 characters.
            </p>
          </div>

          {shownError ? (
            <p className={`${s.note} ${s.noteErr}`} role="alert">
              {shownError}
            </p>
          ) : null}
          {shownNotice ? (
            <p className={`${s.note} ${s.noteOk}`} role="status">
              {shownNotice}
            </p>
          ) : null}

          <SubmitAuth mode={mode} forceBusy={state === 'loading'} />

          <p className={s.fine} id={`${id}-fine`}>
            Your gaps stay private to you until you lock them.
          </p>
        </form>
      </main>
    </div>
  );
}

/** One submit per mode, posting to the existing server action; busy while the action runs. */
function SubmitAuth({ mode, forceBusy }: { mode: AuthMode; forceBusy: boolean }) {
  const { pending } = useFormStatus();
  const busy = pending || forceBusy;
  const label = mode === 'sign-in' ? 'Sign in' : 'Create account';
  const pendingLabel = mode === 'sign-in' ? 'Signing in…' : 'Creating…';
  return (
    <button
      type="submit"
      formAction={mode === 'sign-in' ? signIn : signUp}
      className={`${s.btn} ${s.btnSolid} ${s.btnBlock}`}
      disabled={busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className={s.spin} aria-hidden="true" /> : null}
      {busy ? pendingLabel : label}
    </button>
  );
}
