/**
 * The SpecFix mark: an S and an F drawn with one stroke weight and slanted together.
 * Square (1:1) at every size. `app/icon.svg` is the same mark on the app-icon tile.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <g
        transform="skewX(-14) translate(9 0)"
        stroke="currentColor"
        strokeWidth={8.5}
        strokeLinejoin="round"
      >
        <path d="M32 14H20a8 8 0 0 0 0 16h5a8 8 0 0 1 0 16H9" />
        <path d="M41 50V14h16M41 31h12" />
      </g>
    </svg>
  );
}
