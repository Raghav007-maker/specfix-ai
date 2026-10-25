'use client';

import { useId, useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';

/**
 * A form whose submit asks for confirmation first, for steps that cannot be undone.
 *
 * It is the same `<form action={...}>` with the same hidden fields as before: the dialog only
 * sits between the click and the submit. Without JavaScript the button submits directly, as
 * the plain form did. Native `<dialog>` + showModal() provides focus containment, Escape to
 * cancel, and focus return.
 */
export function ConfirmSubmit({
  action,
  fields,
  label,
  pendingLabel,
  title,
  body,
  confirmLabel,
  variant = 'default',
}: {
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  label: ReactNode;
  pendingLabel?: ReactNode;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const titleId = useId();
  const bodyId = useId();

  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={(event) => {
        if (confirmed.current) {
          confirmed.current = false;
          return;
        }
        event.preventDefault();
        dialogRef.current?.showModal();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton variant={variant} pendingLabel={pendingLabel} className="max-sm:w-full">
        {label}
      </SubmitButton>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-[min(28rem,calc(100vw-2rem))] overscroll-contain rounded-lg border border-border bg-sheet p-0 text-text shadow-float backdrop:bg-text/30"
      >
        <div className="space-y-2 p-5">
          <h2 id={titleId} className="text-balance text-base font-semibold">
            {title}
          </h2>
          <div id={bodyId} className="text-sm leading-5 text-muted-foreground">
            {body}
          </div>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => dialogRef.current?.close()}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant}
            onClick={() => {
              confirmed.current = true;
              dialogRef.current?.close();
              formRef.current?.requestSubmit();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </form>
  );
}
