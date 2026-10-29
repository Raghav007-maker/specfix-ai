'use client';

import { startTransition, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BillingPeriod } from '@specfix/shared/pricing';
import type { UtrState } from './upi-dialog';

export type StartRazorpay = (
  period: BillingPeriod
) => Promise<
  | { status: 'ok'; orderId: string; amountPaise: number; keyId: string }
  | { status: 'error'; error: string }
>;

export type ConfirmRazorpay = (input: {
  orderId: string;
  paymentId: string;
  signature: string;
}) => Promise<UtrState>;

interface CheckoutResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface CheckoutInstance {
  open(): void;
  on(
    event: 'payment.failed',
    handler: (response: { error?: { description?: string } }) => void
  ): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => CheckoutInstance;
  }
}

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** Loads Razorpay's Checkout script once; false if it cannot be fetched. */
function loadCheckout(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

export type CheckoutStatus =
  { state: 'idle' } | { state: 'busy' } | { state: 'paid' } | { state: 'error'; message: string };

/**
 * Pays for Pro through Razorpay Checkout: the server creates the order, Razorpay's own window
 * takes the payment, and the server checks Razorpay's signature before Pro starts.
 */
export function useRazorpayCheckout(start: StartRazorpay, confirm: ConfirmRazorpay) {
  const router = useRouter();
  const [status, setStatus] = useState<CheckoutStatus>({ state: 'idle' });

  const pay = useCallback(
    async (period: BillingPeriod) => {
      const fail = (message: string) => setStatus({ state: 'error', message });
      setStatus({ state: 'busy' });
      const started = await start(period).catch(() => null);
      if (!started) return fail('Could not reach SpecFix. Nothing was charged; try again.');
      if (started.status !== 'ok') return fail(started.error);
      if (!(await loadCheckout()) || !window.Razorpay) {
        return fail('Could not load Razorpay. Check your internet and try again.');
      }

      const checkout = new window.Razorpay({
        key: started.keyId,
        amount: started.amountPaise,
        currency: 'INR',
        order_id: started.orderId,
        name: 'SpecFix',
        description: `Pro (${period})`,
        theme: { color: '#2b5fd9' },
        modal: { ondismiss: () => setStatus({ state: 'idle' }) },
        // Inside a transition, so the page re-renders with the new plan as soon as the action
        // returns; called bare from Razorpay's callback, Next skipped that refresh.
        handler: (response: CheckoutResponse) =>
          startTransition(async () => {
            const result = await confirm({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            }).catch(() => null);
            if (result?.status === 'sent') {
              setStatus({ state: 'paid' });
              router.refresh();
            } else {
              fail(
                result?.error ??
                  'Your payment went through but SpecFix could not confirm it yet. It will switch on when Razorpay tells us; contact the team if it does not.'
              );
            }
          }),
      });
      checkout.on('payment.failed', (response) =>
        fail(response.error?.description ?? 'The payment failed. Nothing was charged.')
      );
      checkout.open();
    },
    [start, confirm, router]
  );

  return { status, pay };
}
