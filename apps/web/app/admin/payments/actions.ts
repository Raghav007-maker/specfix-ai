'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { isAppOwner, PLAN_DATE } from '@/lib/plan';
import { PaymentError, decidePayment } from '@/lib/repos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function back(outcome: { notice: string } | { error: string }): never {
  redirect(`/admin/payments?${new URLSearchParams(outcome).toString()}`);
}

/**
 * Approve or reject a UPI payment after checking its UTR in the bank app. SpecFix's own team
 * only; anyone else gets the same 404 as the page.
 */
export async function decidePaymentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (!isAppOwner(user)) notFound();

  const id = String(formData.get('paymentId') ?? '');
  const decision = formData.get('decision');
  if (!UUID.test(id) || (decision !== 'paid' && decision !== 'rejected')) {
    back({ error: 'That request was not understood.' });
  }

  let message: string;
  try {
    const { proUntil } = await decidePayment(id, user.id, decision);
    message = proUntil
      ? `Approved. The workspace is on Pro until ${PLAN_DATE.format(proUntil)}.`
      : 'Rejected. The workspace was told the payment could not be confirmed.';
  } catch (error) {
    if (error instanceof PaymentError) back({ error: error.message });
    throw error;
  }
  revalidatePath('/admin/payments');
  back({ notice: message });
}
