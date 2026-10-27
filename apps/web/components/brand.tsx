import { MARK, WORDMARK } from '@/components/playground/logo-paths';

/**
 * The SpecFix SF mark, traced from the supplied logo sheet. Square (1:1) at every size, with the
 * mark centred, so it drops in wherever the old mark sat. `app/icon.svg` is the same mark on the
 * app-icon tile.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  const pad = (MARK.width - MARK.height) / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 ${-pad} ${MARK.width} ${MARK.width}`}
      aria-hidden="true"
      className={className}
    >
      <path d={MARK.d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** The SpecFix wordmark from the same sheet, `height` px tall, in the current text colour. */
export function LogoWordmark({ height = 18, className }: { height?: number; className?: string }) {
  return (
    <svg
      height={height}
      width={(height * WORDMARK.width) / WORDMARK.height}
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      aria-hidden="true"
      className={className}
    >
      <path d={WORDMARK.d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
