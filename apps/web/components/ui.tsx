import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Hand-vendored primitives styled to DESIGN.md (Review desk). All are server-safe (no hooks), so
// they compose freely inside server components and forms; the client islands live in
// submit-button.tsx and confirm-dialog.tsx.

type ButtonVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost';
type ButtonSize = 'default' | 'sm';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,transform] duration-150 ease-out active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress';

// `default` is the one near-black primary per screen. `outline` and `secondary` are the same
// bordered white button; both names stay because pages not yet redesigned pass them.
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-sheet hover:bg-primary/85',
  secondary: 'border border-control bg-sheet text-text hover:border-field',
  outline: 'border border-control bg-sheet text-text hover:border-field',
  ghost: 'text-muted-foreground hover:bg-raised hover:text-text',
  destructive: 'border border-negative/40 bg-sheet text-negative hover:border-negative',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  default: 'h-9 px-4 text-sm max-sm:h-11',
  sm: 'h-8 px-3 text-sm max-sm:h-11',
};

export function buttonClasses(variant: ButtonVariant = 'default', size: ButtonSize = 'default') {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size]);
}

export type { ButtonVariant, ButtonSize };

export function Button({
  variant = 'default',
  size = 'default',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={cn(buttonClasses(variant, size), className)} {...props} />;
}

/** A plain text link: ink, underlined on hover. */
export const linkClasses =
  'rounded-sm underline-offset-[3px] transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-sheet text-text', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col space-y-1.5 p-5', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('font-semibold leading-tight', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

const FIELD_BASE =
  'w-full rounded-md border border-field bg-sheet text-sm text-text transition-colors placeholder:text-muted-foreground hover:border-text/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-negative';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(FIELD_BASE, 'flex h-[38px] px-3', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(FIELD_BASE, 'flex min-h-[80px] px-3 py-2 leading-5', className)}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(FIELD_BASE, 'h-[38px] px-2', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium leading-5', className)} {...props} />;
}

export type PillTone = 'positive' | 'negative' | 'warning' | 'neutral' | 'accent';

const PILL_TONES: Record<PillTone, string> = {
  positive: 'bg-positive-bg text-positive-ink',
  negative: 'bg-negative-bg text-negative-ink',
  warning: 'bg-warning-bg text-warning-ink',
  neutral: 'bg-neutral-bg text-neutral-ink',
  accent: 'bg-teal-tag text-teal-ink',
};

/** A status as a pale tint with dark ink of the same hue. The word always carries the meaning. */
export function Pill({
  tone,
  children,
  className,
}: {
  tone: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center whitespace-nowrap rounded-sm px-1.5 text-xs font-medium tabular-nums',
        PILL_TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

// Legacy badge API for pages not yet on the Review desk design, mapped onto the pill pairs.
type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'muted';

const BADGE_TO_PILL: Record<BadgeTone, PillTone> = {
  neutral: 'neutral',
  primary: 'accent',
  success: 'positive',
  warning: 'warning',
  danger: 'negative',
  muted: 'neutral',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <Pill tone={BADGE_TO_PILL[tone]} className={className}>
      {children}
    </Pill>
  );
}

type NoticeTone = 'error' | 'warning' | 'info' | 'success';

const NOTICE_TONES: Record<NoticeTone, string> = {
  error: 'border-negative/30 bg-negative-bg text-negative-ink',
  warning: 'border-warning-line bg-warning-bg text-warning-ink',
  info: 'border-border bg-raised text-text',
  success: 'border-positive/30 bg-positive-bg text-positive-ink',
};

/** An inline message inside the block it concerns. Errors are announced; success is polite. */
export function Notice({
  tone,
  title,
  children,
  className,
}: {
  tone: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : tone === 'success' ? 'status' : undefined}
      className={cn('rounded-lg border px-4 py-3 text-sm leading-5', NOTICE_TONES[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title ? 'mt-1' : null)}>{children}</div> : null}
    </div>
  );
}

/** Section title at 16/600 with an optional count and a trailing slot. */
export function SectionHeading({
  id,
  children,
  count,
  aside,
  as: Tag = 'h2',
}: {
  id?: string;
  children: ReactNode;
  count?: number;
  aside?: ReactNode;
  as?: 'h2' | 'h3';
}) {
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <Tag id={id} className="text-base font-semibold">
        {children}
        {count !== undefined ? (
          <span className="ml-2 font-normal tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </Tag>
      {aside}
    </div>
  );
}

/** A block with nothing in it yet: its frame stays and one sentence says why. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-control px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
