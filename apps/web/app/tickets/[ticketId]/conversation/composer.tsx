'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { Button, Label, Notice, Textarea } from '@/components/ui';
import { sendAgentMessage, type SendState } from './actions';

const INITIAL: SendState = { status: 'idle' };

/**
 * The message box. A client island for one reason the plain-form pattern cannot cover: a
 * send that fails (timeout, provider error) must leave the reviewer's words in the box,
 * and a redirect would throw them away. It still posts a real `<form>` to the server
 * action, so without JavaScript it submits and the page re-renders as any other form.
 *
 * Enter sends, Shift+Enter is a new line — except on touch screens, whose keyboards have no
 * Shift+Enter, where Enter is a new line and the button sends. Nothing sends while a reply is pending or
 * while the box holds only whitespace — the server checks all of this again.
 *
 * The length cap arrives as a prop rather than an import: @specfix/shared also holds
 * node-only code (node:crypto), which cannot enter a client bundle.
 */
export function Composer({
  ticketId,
  flagId,
  maxChars,
  disabled,
}: {
  ticketId: string;
  flagId: string;
  maxChars: number;
  disabled?: boolean;
}) {
  const [state, action, pending] = useActionState(sendAgentMessage, INITIAL);
  const [text, setText] = useState('');
  const [sending, setSending] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  // Decided after mount: the server render cannot know the pointer type.
  const [enterSends, setEnterSends] = useState(true);
  useEffect(() => {
    setEnterSends(!window.matchMedia('(pointer: coarse)').matches);
  }, []);
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  const errorId = `${id}-error`;
  const countId = `${id}-count`;

  // A successful send clears the box; a failed one leaves the text for a retry.
  useEffect(() => {
    if (state.status === 'sent') setText('');
    setLocalError(null);
  }, [state.sentAt, state.status]);

  const trimmed = text.trim();
  const tooLong = trimmed.length > maxChars;
  const canSend = !pending && !disabled && trimmed !== '' && !tooLong;
  const error = localError ?? (state.status === 'error' && !pending ? state.error : null);
  const showCount = text.length > maxChars * 0.8;

  return (
    <form
      ref={formRef}
      action={action}
      onSubmit={(event) => {
        if (!canSend) {
          event.preventDefault();
          if (!pending && trimmed === '') setLocalError('Write a message before sending.');
          return;
        }
        setLocalError(null);
        setSending(trimmed);
      }}
      className="space-y-2"
      aria-busy={pending || undefined}
    >
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="flagId" value={flagId} />

      {pending ? (
        <div role="status" className="space-y-2 border-t border-rule pt-3">
          <p className="text-xs text-muted-foreground">You</p>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-raised px-3 py-2 text-sm leading-5">
            {sending}
          </p>
          <p className="text-sm text-muted-foreground">The agent is replying…</p>
        </div>
      ) : null}

      {error ? (
        <Notice tone="error">
          <span id={errorId}>{error}</span>
        </Notice>
      ) : null}

      <Label htmlFor={`${id}-message`} className="block">
        Your answer
      </Label>
      <Textarea
        id={`${id}-message`}
        name="message"
        rows={3}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (localError) setLocalError(null);
        }}
        onKeyDown={(event) => {
          if (
            enterSends &&
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (canSend) formRef.current?.requestSubmit();
          }
        }}
        disabled={disabled}
        readOnly={pending}
        autoComplete="off"
        maxLength={maxChars + 500}
        aria-invalid={tooLong || Boolean(error) || undefined}
        aria-describedby={[error ? errorId : null, countId].filter(Boolean).join(' ')}
        placeholder="Answer in your own words, or ask what the flag means…"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={countId} className="text-xs tabular-nums text-muted-foreground">
          {tooLong ? (
            <span className="text-negative">
              {trimmed.length} of {maxChars} characters — shorten your message
            </span>
          ) : showCount ? (
            `${trimmed.length} of ${maxChars} characters`
          ) : enterSends ? (
            'Enter to send · Shift+Enter for a new line'
          ) : (
            'Tap Send when you’re done'
          )}
        </p>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={pending || disabled || tooLong}
          aria-busy={pending || undefined}
        >
          {pending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
