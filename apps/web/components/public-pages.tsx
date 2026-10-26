'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULTS, cssVars, dataAttrs } from '@/components/playground/settings';
import { LandingPreview } from '@/components/playground/landing-preview';
import { LoginPreview, type AuthMode } from '@/components/playground/login-preview';
import p from '@/components/playground/playground.module.css';

/** The public pages share the playground's default ("Editorial") design, after the reference video. */
function Root({ view, children }: { view: string; children: ReactNode }) {
  const style = { ...cssVars(DEFAULTS), minHeight: '100vh' } as CSSProperties;
  return (
    <div
      className={p.root}
      data-pg-preview=""
      data-view={view}
      style={style}
      {...dataAttrs(DEFAULTS)}
    >
      <div className={p.view}>{children}</div>
    </div>
  );
}

/** The public landing page for signed-out visitors. */
export function PublicLanding() {
  const router = useRouter();
  return (
    <Root view="landing">
      <LandingPreview
        settings={DEFAULTS}
        go={(_, mode) => router.push(mode === 'sign-up' ? '/login?mode=sign-up' : '/login')}
      />
    </Root>
  );
}

/**
 * The sign-in page. It posts to the existing `signIn` and `signUp` server actions, which redirect
 * back here with `?error=` or `?message=` exactly as before; those messages are shown as they come.
 */
export function PublicSignIn({
  error,
  message,
  initialMode = 'sign-in',
}: {
  error?: string;
  message?: string;
  initialMode?: AuthMode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  return (
    <Root view="login">
      <LoginPreview
        settings={DEFAULTS}
        mode={mode}
        setMode={setMode}
        goHome={() => router.push('/')}
        error={error}
        message={message}
      />
    </Root>
  );
}
