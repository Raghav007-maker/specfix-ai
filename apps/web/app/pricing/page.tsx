import type { Metadata } from 'next';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { FREE_PROJECT_LIMIT, latestPayment, listProjects, proCta, tenantPlan } from '@/lib/repos';
import { PLAN_DATE, isAppOwner, razorpaySetup, upiSetup } from '@/lib/plan';
import { confirmRazorpayAction, startRazorpayAction, submitUtrAction } from './actions';
import { AppShell } from '@/components/app-shell';
import { PricingSurface } from '@/components/pricing-surface';

export const metadata: Metadata = { title: 'Pricing · SpecFix' };

/**
 * Plans and pricing for the current workspace: Free and Pro, with Pro Max and Enterprise still
 * to come. Upgrading pays by UPI and submits the UTR; Pro starts when the team confirms it.
 */
export default async function PricingPage() {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const [projects, plan, payment] = await Promise.all([
    listProjects(tenant.tenant_id),
    tenantPlan(tenant.tenant_id),
    latestPayment(tenant.tenant_id),
  ]);
  const appOwner = isAppOwner(user);
  const cta = proCta({ pro: plan.pro, appOwner, role: tenant.role });
  // Only someone who can pay opens the dialog, so only they need the QR codes.
  const canPay = cta === 'upgrade' || cta === 'extend';
  const upi = canPay ? await upiSetup(user.id) : null;
  const razorpay = canPay ? razorpaySetup() : null;

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="pricing"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Pricing</span>
        </p>
      }
    >
      <PricingSurface
        pay={{
          submitUtr: submitUtrAction,
          startRazorpay: startRazorpayAction,
          confirmRazorpay: confirmRazorpayAction,
        }}
        account={{
          plan: appOwner ? 'team' : plan.pro ? 'pro' : 'free',
          proUntil: plan.pro && plan.proUntil ? PLAN_DATE.format(plan.proUntil) : null,
          projectCount: plan.projectCount,
          projectLimit: FREE_PROJECT_LIMIT,
          cta,
          upi,
          razorpay,
          // Only a UPI claim can wait or be rejected; Razorpay payments start Pro on their own.
          payment:
            payment && payment.method === 'upi' && payment.status !== 'created'
              ? {
                  status: payment.status,
                  utr: payment.utr ?? '',
                  rupees: payment.amount_paise / 100,
                }
              : null,
        }}
      />
    </AppShell>
  );
}
