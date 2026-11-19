import type { CSSProperties, ReactNode } from 'react';
import { DEFAULTS, cssVars, dataAttrs } from '@/components/playground/settings';
import p from '@/components/playground/playground.module.css';

/** The sign-in page's frame (same palette and column) for the smaller auth pages. */
export function AuthPanel({ children }: { children: ReactNode }) {
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
          <main className={p.loginSide}>{children}</main>
        </div>
      </div>
    </div>
  );
}

export { p as authStyles };
