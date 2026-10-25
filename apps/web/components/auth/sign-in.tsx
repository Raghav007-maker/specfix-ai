'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { signIn, signUp } from '@/app/(auth)/actions';
import { LogoMark } from '@/components/brand';
import { createPlanet } from '@/components/landing/planet';
import s from './sign-in.module.css';

type Mode = 'sign-in' | 'sign-up';

/**
 * The sign-in screen. One form, two submit buttons that post to the existing `signIn` and
 * `signUp` server actions, with the same `email` and `password` fields. Errors and notices
 * come from the actions' `?error=` / `?message=` redirects, exactly as before.
 */
export function SignIn({ error, message }: { error?: string; message?: string }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className={s.page}>
      <EarthPanel />

      <main id="main" className={s.side}>
        <Link className={s.back} href="/">
          Back to SpecFix
        </Link>

        <form className={`${s.form} page-enter`}>
          <h1 className={s.title}>Sign in to SpecFix</h1>
          <p className={s.intro}>Use the email your workspace invited.</p>

          <div className={s.field}>
            <label className={s.label} htmlFor="email">
              Email
            </label>
            <div className={s.box}>
              <input
                className={s.input}
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="name@company.com"
                required
              />
            </div>
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="password">
              Password
            </label>
            <div className={s.box}>
              <input
                className={s.input}
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                required
                minLength={6}
                aria-describedby="password-help"
              />
              <button
                className={s.eye}
                type="button"
                aria-controls="password"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <p className={s.help} id="password-help">
              At least 6 characters.
            </p>
          </div>

          {error ? (
            <p className={`${s.note} ${s.error}`} role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className={`${s.note} ${s.message}`} role="status">
              {message}
            </p>
          ) : null}

          <div className={s.actions}>
            <AuthButton
              mode="sign-in"
              current={mode}
              onChoose={setMode}
              formAction={signIn}
              className={s.primary}
              label="Sign in"
              pendingLabel="Signing in…"
            />
            <AuthButton
              mode="sign-up"
              current={mode}
              onChoose={setMode}
              formAction={signUp}
              className={s.secondary}
              label="Create account"
              pendingLabel="Creating…"
            />
          </div>
          <p className={s.fine}>Your gaps stay private to you until you lock them.</p>
        </form>
      </main>
    </div>
  );
}

/** A submit button that shows the loading state only when it is the one that was pressed. */
function AuthButton({
  mode,
  current,
  onChoose,
  formAction,
  className,
  label,
  pendingLabel,
}: {
  mode: Mode;
  current: Mode;
  onChoose: (mode: Mode) => void;
  formAction: (formData: FormData) => Promise<void>;
  className: string | undefined;
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  const busy = pending && current === mode;
  return (
    <button
      className={`${s.btn} ${className}`}
      type="submit"
      formAction={formAction}
      onClick={() => onChoose(mode)}
      disabled={pending}
      aria-busy={busy || undefined}
    >
      {busy ? <span className={s.spin} aria-hidden="true" /> : null}
      {busy ? pendingLabel : label}
    </button>
  );
}

function EarthPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const planet = createPlanet(canvas);
    const place = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const phone = window.innerWidth < 900;
      planet.set(
        phone
          ? { x: w * 0.5, y: h * 1.05, r: Math.min(w * 0.75, 380), sx: -0.3, sy: 0.8, sz: 0.5 }
          : { x: w * 0.52, y: h * 0.42, r: Math.min(w * 0.36, h * 0.34), sx: -0.6, sy: 0.5, sz: 0.62 },
        true
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      planet.dispose();
    };
  }, []);

  return (
    <section className={s.art} aria-label="SpecFix">
      <canvas ref={canvasRef} className={s.planet} aria-hidden="true" />
      <Link className={s.word} href="/" aria-label="SpecFix home">
        <LogoMark size={24} />
        <span>
          SPEC<b>F</b>IX
        </span>
      </Link>
      <div className={s.caption}>
        <p>Review the ticket before anyone builds it</p>
        <small>
          Write your own gaps first, then see what the model found. Every flag ends as a decision in
          the audit trail.
        </small>
      </div>
    </section>
  );
}
