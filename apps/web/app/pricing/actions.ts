'use server';

import { revalidatePath } from 'next/cache';
import { PRO_PRICES, isBillingPeriod, paymentRef } from '@specfix/shared';
import {
  RazorpayError,
  createRazorpayOrder,
  verifyRazorpayPaymentSignature,
} from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { razorpayKeys } from '@/lib/plan';
import {
  PaymentError,
  confirmRazorpayPayment,
  recordRazorpayOrder,
  submitUpiPayment,
} from '@/lib/repos';
import type { UtrState } from '@/components/playground/upi-dialog';

/**
 * Records a UPI payment's UTR for the team to confirm. The workspace comes from the session and
 * the amount from the period's price, never from the form; the repository re-checks the role.
 * Returns a state rather than redirecting, so a typo leaves the UTR in the box to fix.
 */
export async function submitUtrAction(_previous: UtrState, formData: FormData): Promise<UtrState> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const period = formData.get('period');
  if (!isBillingPeriod(period)) return { status: 'error', error: 'Choose monthly or annual.' };

  try {
    await submitUpiPayment(tenant.tenant_id, user.id, {
      period,
      utr: String(formData.get('utr') ?? ''),
    });
  } catch (error) {
    if (error instanceof PaymentError) return { status: 'error', error: error.message };
    console.error('[pricing] UTR submit failed:', error instanceof Error ? error.message : error);
    return { status: 'error', error: 'The payment could not be submitted. Please try again.' };
  }
  revalidatePath('/pricing');
  return { status: 'sent' };
}

export type StartRazorpayResult =
  | { status: 'ok'; orderId: string; amountPaise: number; keyId: string }
  | { status: 'error'; error: string };

/**
 * Creates a Razorpay order at the price for `period` and records it for this workspace. Only
 * owners and admins; the price comes from the server's list.
 */
export async function startRazorpayAction(period: unknown): Promise<StartRazorpayResult> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  if (!isBillingPeriod(period)) return { status: 'error', error: 'Choose monthly or annual.' };
  if (tenant.role === 'reviewer') {
    return { status: 'error', error: 'Only an owner or admin can pay for this workspace.' };
  }
  const keys = razorpayKeys();
  if (!keys) return { status: 'error', error: 'Razorpay is not set up yet. Ask the SpecFix team.' };

  const amountPaise = PRO_PRICES[period].paise;
  try {
    const orderId = await createRazorpayOrder(keys, {
      amountPaise,
      receipt: paymentRef(tenant.tenant_id),
      notes: { workspace: paymentRef(tenant.tenant_id), period },
    });
    await recordRazorpayOrder(tenant.tenant_id, user.id, { period, orderId });
    return { status: 'ok', orderId, amountPaise, keyId: keys.keyId };
  } catch (error) {
    if (error instanceof RazorpayError || error instanceof PaymentError) {
      return { status: 'error', error: error.message };
    }
    console.error(
      '[pricing] Razorpay order failed:',
      error instanceof Error ? error.message : error
    );
    return { status: 'error', error: 'The payment could not be started. Please try again.' };
  }
}

/**
 * Called by the Checkout once Razorpay has taken the payment. Pro starts only if Razorpay's
 * signature for this order and payment checks out against the key secret, and the order belongs
 * to this workspace.
 */
export async function confirmRazorpayAction(input: {
  orderId: unknown;
  paymentId: unknown;
  signature: unknown;
}): Promise<UtrState> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const keys = razorpayKeys();
  const { orderId, paymentId, signature } = input;
  if (
    !keys ||
    typeof orderId !== 'string' ||
    typeof paymentId !== 'string' ||
    typeof signature !== 'string' ||
    !verifyRazorpayPaymentSignature({ orderId, paymentId, signature }, keys.keySecret)
  ) {
    return { status: 'error', error: 'Razorpay could not confirm this payment.' };
  }
  try {
    await confirmRazorpayPayment({ orderId, paymentId, tenantId: tenant.tenant_id });
  } catch (error) {
    if (error instanceof PaymentError) return { status: 'error', error: error.message };
    console.error(
      '[pricing] Razorpay confirm failed:',
      error instanceof Error ? error.message : error
    );
    return {
      status: 'error',
      error:
        'Your payment went through but Pro could not be switched on yet. Contact the SpecFix team.',
    };
  }
  revalidatePath('/pricing');
  return { status: 'sent' };
}
