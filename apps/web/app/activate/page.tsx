import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { FREE_MEMBER_LIMIT, FREE_PROJECT_LIMIT, WORKSPACE_FEE_PAISE } from '@specfix/shared';
import { requireUser } from '@/lib/session';
import { currentTenant } from '@/lib/tenant';
import { latestPayment } from '@/lib/repos';
import { razorpaySetup, upiSetup } from '@/lib/plan';
import { Card, CardContent, CardHeader, CardTitle, Notice } from '@/components/ui';
import { confirmRazorpayAction, startRazorpayAction, submitUtrAction } from '../pricing/actions';
import { PayFee } from './pay';

export const metadata: Metadata = { title: 'Open your workspace · SpecFix' };

/**
 * A new workspace waits here until its one-time fee is paid; then it opens on the Free plan.
 * Every other page sends its owner here while it is closed.
 */
export default async function ActivatePage() {
  const user = await requireUser();
  const tenant = await currentTenant(user.id);
  if (!tenant) redirect('/onboarding');
  if (tenant.open) redirect('/');
  if (tenant.role !== 'owner') notFound();

  const [payment, upi] = await Promise.all([latestPayment(tenant.tenant_id), upiSetup(user.id)]);
  const waiting = payment?.period === 'workspace' && payment.status === 'pending';
  const rejected = payment?.period === 'workspace' && payment.status === 'rejected';
  const rupees = WORKSPACE_FEE_PAISE / 100;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Open {tenant.tenant_name}</CardTitle>
          <p className="text-sm text-muted-foreground">
            A new workspace costs ₹{rupees} once. It then starts on the Free plan: up to{' '}
            {FREE_PROJECT_LIMIT} projects and {FREE_MEMBER_LIMIT} admins and reviewers. You can move
            it to Pro later.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {waiting ? (
            <Notice tone="info">
              Your payment (UTR {payment.utr}) is waiting for the SpecFix team to confirm it. The
              workspace opens as soon as they do.
            </Notice>
          ) : (
            <>
              {rejected ? (
                <Notice tone="error">
                  The last payment could not be confirmed. Check the UTR and pay again.
                </Notice>
              ) : null}
              <PayFee
                rupees={rupees}
                pay={{
                  submitUtr: submitUtrAction,
                  startRazorpay: startRazorpayAction,
                  confirmRazorpay: confirmRazorpayAction,
                }}
                upi={upi}
                razorpay={razorpaySetup()}
              />
            </>
          )}
          <p className="text-center text-sm text-muted-foreground">
            Only joining a team?{' '}
            <Link href="/join" className="underline underline-offset-2">
              Continue as a reviewer
            </Link>{' '}
            — no charge.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
