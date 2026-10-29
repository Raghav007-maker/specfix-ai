import 'server-only';
import { cache } from 'react';
import type { User } from '@supabase/supabase-js';
import { resolutionAgentEnabled } from '@/lib/agent';
import QRCode from 'qrcode';
import { PRO_PRICES, isUpiId, paymentRef, upiPayLink, type BillingPeriod } from '@specfix/shared';
import {
  agentAccessFor,
  isAppOwnerEmail,
  planNotice,
  tenantPlan,
  type AgentAccess,
  type MembershipRow,
} from '@/lib/repos';

export type { AgentAccess };

/**
 * Plan checks for the web app. SpecFix's own team is listed by email in .env and gets every
 * feature in any workspace:
 *
 *   SPECFIX_OWNER_EMAILS=a@example.com,b@example.com
 */
export function isAppOwner(user: User): boolean {
  return isAppOwnerEmail(
    process.env.SPECFIX_OWNER_EMAILS,
    user.email,
    Boolean(user.email_confirmed_at)
  );
}

/** 'off' when the feature flag is off everywhere; 'locked' on a Free workspace. */
export async function agentAccess(user: User, tenantId: string): Promise<AgentAccess> {
  const enabled = resolutionAgentEnabled();
  const appOwner = isAppOwner(user);
  // The plan is read only when it can change the answer.
  const pro = enabled && !appOwner && (await tenantPlan(tenantId)).pro;
  return agentAccessFor({ enabled, appOwner, pro });
}

/** What the top-bar notice says, already formatted, or null when there is nothing to say. */
export interface PlanNoticeText {
  title: string;
  body: string;
}

export const PLAN_DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});

/**
 * Only owners and admins can act on a plan, and the app's own team has no limits. Cached per
 * request: the shell renders the notice in both its desktop and phone bars.
 */
export const planNoticeFor = cache(async function planNoticeFor(
  user: User,
  tenant: MembershipRow
): Promise<PlanNoticeText | null> {
  if (tenant.role === 'reviewer' || isAppOwner(user)) return null;
  const notice = planNotice(await tenantPlan(tenant.tenant_id));
  if (!notice) return null;
  switch (notice.kind) {
    case 'renew':
      return {
        title: `Your Pro plan ends on ${PLAN_DATE.format(notice.on)}`,
        body: 'Renew to keep the Conversational agent and unlimited projects.',
      };
    case 'lapsed':
      return {
        title: `Your Pro plan ended on ${PLAN_DATE.format(notice.on)}`,
        body: 'This workspace is on Free now: up to 5 projects and no Conversational agent.',
      };
    case 'near-limit':
      return {
        title: `${notice.used} of ${notice.limit} free projects used`,
        body: 'One project left on the Free plan. Pro removes the limit.',
      };
    case 'at-limit':
      return {
        title: `${notice.used} of ${notice.limit} free projects used`,
        body: 'Upgrade to Pro to add more projects.',
      };
  }
});

/** Where Pro payments go, with a ready QR per period; null until .env names a valid UPI ID. */
export interface UpiSetup {
  payee: string;
  payeeName: string;
  /** This workspace's code, carried in the payment note (`paymentRef`). */
  ref: string;
  pay: Record<BillingPeriod, { link: string; qr: string }>;
}

/**
 * SpecFix's UPI ID for Pro payments, from .env:
 *
 *   UPI_PAYEE_VPA=name@bank
 *   UPI_PAYEE_NAME=SpecFix
 *
 * The QR is an SVG data URL drawn from the upi:// link, so the page shows it as an image.
 */
export async function upiSetup(tenantId: string): Promise<UpiSetup | null> {
  const payee = process.env.UPI_PAYEE_VPA?.trim() ?? '';
  if (!isUpiId(payee)) return null;
  const payeeName = process.env.UPI_PAYEE_NAME?.trim() || 'SpecFix';
  const ref = paymentRef(tenantId);
  const entry = async (period: BillingPeriod) => {
    const link = upiPayLink({
      payee,
      payeeName,
      paise: PRO_PRICES[period].paise,
      note: `SpecFix Pro ${period} ${ref}`,
    });
    const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { link, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  };
  return {
    payee,
    payeeName,
    ref,
    pay: { monthly: await entry('monthly'), annual: await entry('annual') },
  };
}

/**
 * Razorpay for Pro payments, from .env (test keys start with rzp_test_):
 *
 *   RAZORPAY_KEY_ID=rzp_test_...       public, sent to the browser Checkout
 *   RAZORPAY_KEY_SECRET=...            server only: creates orders, checks Checkout signatures
 *   RAZORPAY_WEBHOOK_SECRET=...        server only: checks webhook signatures
 */
export interface RazorpaySetup {
  keyId: string;
  test: boolean;
}

export function razorpayKeys(): { keyId: string; keySecret: string } | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim() ?? '';
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) || !keySecret) return null;
  return { keyId, keySecret };
}

/** What the browser may know: the public key id, and whether it is a test key. */
export function razorpaySetup(): RazorpaySetup | null {
  const keys = razorpayKeys();
  return keys ? { keyId: keys.keyId, test: keys.keyId.startsWith('rzp_test_') } : null;
}
