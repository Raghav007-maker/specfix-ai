import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { paymentRef } from '@specfix/shared';
import { isAppOwner, PLAN_DATE } from '@/lib/plan';
import { listPaymentsForReview, listProjects } from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import { EmptyNote, Notice, Pill } from '@/components/ui';
import { decidePaymentAction } from './actions';

export const metadata: Metadata = { title: 'Payments · SpecFix', robots: { index: false } };

// Payments change while the page is open; never serve a cached copy.
export const dynamic = 'force-dynamic';

const STATUS = {
  created: { tone: 'neutral', label: 'Not paid' },
  pending: { tone: 'warning', label: 'Waiting' },
  paid: { tone: 'positive', label: 'Paid' },
  rejected: { tone: 'negative', label: 'Rejected' },
} as const;

/**
 * UPI payments from every workspace, for SpecFix's own team (SPECFIX_OWNER_EMAILS) to check
 * against their bank app and approve or reject. Everyone else gets a 404, so the page does not
 * reveal that it exists.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const user = await requireUser();
  if (!isAppOwner(user)) notFound();
  const [tenant, { notice, error }] = await Promise.all([requireTenant(user.id), searchParams]);
  const [projects, payments] = await Promise.all([
    listProjects(tenant.tenant_id),
    listPaymentsForReview(),
  ]);
  const waiting = payments.filter((p) => p.status === 'pending').length;

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="payments"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">SpecFix team</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Payments</span>
        </p>
      }
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.012em]">Payments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check each UTR in the bank app before approving, and that its note shows the
          workspace&rsquo;s code (W-…). Approving starts or extends that workspace&rsquo;s Pro plan.{' '}
          {waiting > 0 ? `${waiting} waiting.` : 'Nothing waiting.'}
        </p>
      </div>

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      ) : null}

      {payments.length === 0 ? (
        <EmptyNote>No payments yet. They appear here when a workspace submits a UTR.</EmptyNote>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-raised text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Workspace
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Amount
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  UTR
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Submitted
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Decision</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-t border-border align-middle">
                  <td className="px-3 py-3">
                    <p className="font-medium">
                      {p.tenant_name}{' '}
                      <code className="font-mono text-xs text-muted-foreground">
                        {paymentRef(p.tenant_id)}
                      </code>
                    </p>
                    <p className="text-xs text-muted-foreground">{p.submitted_by ?? 'unknown'}</p>
                  </td>
                  <td className="px-3 py-3 tabular-nums">
                    ₹{p.amount_paise / 100}
                    <span className="text-muted-foreground"> · {p.period}</span>
                  </td>
                  <td className="px-3 py-3">
                    {/* Razorpay payments confirm themselves; their id is shown for support. */}
                    <span className="font-mono text-[13px]">{p.utr ?? p.razorpay_payment_id}</span>
                    {p.method === 'razorpay' ? (
                      <span className="block text-xs text-muted-foreground">Razorpay</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {PLAN_DATE.format(p.created_at)}
                  </td>
                  <td className="px-3 py-3">
                    <Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
                  </td>
                  <td className="px-3 py-3">
                    {p.status === 'pending' ? (
                      <div className="flex justify-end gap-2">
                        <ConfirmSubmit
                          action={decidePaymentAction}
                          fields={{ paymentId: p.id, decision: 'rejected' }}
                          label="Reject"
                          variant="outline"
                          title="Reject this payment?"
                          body={`The workspace “${p.tenant_name}” stays on its current plan and sees that UTR ${p.utr} could not be confirmed.`}
                          confirmLabel="Reject payment"
                        />
                        <ConfirmSubmit
                          action={decidePaymentAction}
                          fields={{ paymentId: p.id, decision: 'paid' }}
                          label="Approve"
                          title={`Approve ₹${p.amount_paise / 100}?`}
                          body={`Only if the bank app shows UTR ${p.utr} with ₹${p.amount_paise / 100} received and the note “${paymentRef(p.tenant_id)}”. A different code means someone else’s receipt: reject it. “${p.tenant_name}” gets ${p.period === 'annual' ? '365' : '30'} more days of Pro.`}
                          confirmLabel="Approve and start Pro"
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
