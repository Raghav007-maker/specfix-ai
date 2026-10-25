'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui';

/**
 * A submit button that disables itself while its form's server action is in flight, so a
 * slow action (scenario generation calls the model) cannot be posted twice. `pendingLabel`
 * replaces the label while pending. It only reads form status; the form and its action are
 * unchanged.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant,
  size,
  disabled,
  ...props
}: Omit<ComponentProps<'button'>, 'type'> & {
  pendingLabel?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
