import type { CSSProperties } from 'react';
import { MARK, WORDMARK } from './logo-paths';
import s from './playground.module.css';

/** The mark's three strokes, so a loop can lift them one after another without reshaping them. */
const MARK_PARTS = MARK.d
  .split('M')
  .filter(Boolean)
  .map((d) => `M${d}`);

export type LogoVariant = 'lockup' | 'wordmark' | 'mark' | 'icon';
export type LogoAnimation = 'none' | 'draw' | 'rise' | 'wipe';

/** The SF mark alone, at `size` px tall. */
export function SfMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${MARK.width} ${MARK.height}`}
      height={size}
      width={(size * MARK.width) / MARK.height}
      aria-hidden="true"
    >
      {MARK_PARTS.map((d, k) => (
        <g key={k} className={s.markPart} style={{ '--k': k } as CSSProperties}>
          <path className={s.markPath} d={d} pathLength={1} fillRule="evenodd" />
        </g>
      ))}
    </svg>
  );
}

/** The SpecFix wordmark, `size` px tall (cap height reads at roughly 0.9 × size). */
export function Wordmark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      height={size}
      width={(size * WORDMARK.width) / WORDMARK.height}
      aria-hidden="true"
    >
      <path className={s.wordPath} d={WORDMARK.d} fillRule="evenodd" />
    </svg>
  );
}

/** The application icon: the SF mark on its dark rounded tile, as on the supplied sheet. */
export function AppIcon({ size, className }: { size: number; className?: string }) {
  const inner = size * 0.5;
  return (
    <span
      className={`${s.appIcon} ${className ?? ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <SfMark size={inner * (MARK.height / MARK.width)} />
    </span>
  );
}

/**
 * The logo in the variant a context needs. Every variant carries the accessible name, and an
 * animation only moves, clips or fades the artwork; the mark's geometry is never distorted.
 * `loop` repeats a short signature every few seconds after the reveal: the mark's strokes lift
 * in turn and a sheen crosses the lockup. The resting state is the static logo, which is also
 * what reduced motion shows.
 */
export function Logo({
  variant,
  size,
  animation = 'none',
  loop = false,
  className,
}: {
  variant: LogoVariant;
  size: number;
  animation?: LogoAnimation;
  loop?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`${s.logo} ${className ?? ''}`}
      data-anim={animation}
      data-loop={loop ? 'on' : undefined}
      role="img"
      aria-label="SpecFix"
    >
      <span className={s.logoInner}>
        {variant === 'icon' ? <AppIcon size={size * 1.35} className={s.logoMark} /> : null}
        {variant === 'lockup' || variant === 'mark' ? (
          <SfMark size={size} className={s.logoMark} />
        ) : null}
        {variant !== 'mark' ? <Wordmark size={size * 0.82} className={s.logoWord} /> : null}
      </span>
    </span>
  );
}
