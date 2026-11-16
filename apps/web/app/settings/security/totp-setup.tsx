'use client';

import { useState, useTransition } from 'react';
import { Button, Input, Label, Notice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { confirmTotpSetup, startTotpSetup, type TotpSetup as Setup } from './actions';

/**
 * Setting up an authenticator app: start, scan the QR code (or type the key), then confirm
 * with the first 6-digit code. The secret is shown once, only here, and never logged.
 */
export function TotpSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [pending, startTransition] = useTransition();

  if (!setup || setup.status === 'error') {
    return (
      <div className="space-y-3">
        {setup?.status === 'error' ? <Notice tone="error">{setup.error}</Notice> : null}
        <Button
          type="button"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => startTransition(async () => setSetup(await startTotpSetup()))}
        >
          {pending ? 'Starting…' : 'Set up two-step verification'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Open Google Authenticator (or Microsoft Authenticator, Authy) on your phone.</li>
        <li>Add an account and scan this QR code.</li>
        <li>Type the 6-digit code it shows for SpecFix below.</li>
      </ol>
      <img
        src={setup.qr}
        alt="QR code to add SpecFix to your authenticator app"
        width={176}
        height={176}
        className="rounded-md border border-border bg-white p-2"
      />
      <p className="text-sm text-muted-foreground">
        Can&apos;t scan? Enter this key in the app instead:{' '}
        <code className="break-all rounded bg-raised px-1.5 py-0.5 font-mono text-[13px] text-text">
          {setup.secret}
        </code>
      </p>
      <form action={confirmTotpSetup} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="factorId" value={setup.factorId} />
        <div className="space-y-1.5">
          <Label htmlFor="setup-code">6-digit code</Label>
          <Input
            id="setup-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            className="w-40"
          />
        </div>
        <SubmitButton pendingLabel="Checking…">Turn on</SubmitButton>
      </form>
    </div>
  );
}
