/**
 * Payments for Pro, two ways:
 *   - UPI by QR: a workspace owner or admin submits the payment's UTR, and SpecFix's team
 *     approves or rejects it after checking their bank app.
 *   - Razorpay: the server records an order at the price for the period, and it becomes paid
 *     when Razorpay's signature for it checks out (browser Checkout or webhook).
 * Paying extends tenants.pro_until by the period, from today or from the current end of Pro,
 * whichever is later. Every decision locks the payment row, so a repeated click, a webhook
 * racing the browser, or a replayed webhook extends Pro exactly once.
 */
import type { PoolClient } from 'pg';
import {
  PRO_PRICES,
  normalizePayerCode,
  normalizeUtr,
  payerCode,
  type BillingPeriod,
} from '@specfix/shared';
import { tx, query, type TenantId } from '../client.ts';

/** A refusal the person can act on. Shown as-is. */
export class PaymentError extends Error {}

/** 'created' is a Razorpay order not paid yet; it is never shown and blocks nothing. */
export type PaymentStatus = 'created' | 'pending' | 'paid' | 'rejected';

export interface PaymentRow {
  id: string;
  tenant_id: string;
  method: 'upi' | 'razorpay';
  period: BillingPeriod;
  amount_paise: number;
  utr: string | null;
  razorpay_payment_id: string | null;
  status: PaymentStatus;
  created_at: Date;
  decided_at: Date | null;
}

const COLUMNS = `id, tenant_id, method, period, amount_paise, utr, razorpay_payment_id, status,
                 created_at, decided_at`;

async function requirePayer(client: PoolClient, tenantId: TenantId, userId: string) {
  const member = await client.query<{ role: string }>(
    `select role from memberships where tenant_id = $1 and user_id = $2 for share`,
    [tenantId, userId]
  );
  const role = member.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') {
    throw new PaymentError('Only an owner or admin can pay for this workspace.');
  }
}

/** Adds the period to Pro, from today or from the current end of Pro, whichever is later. */
async function extendPro(
  client: PoolClient,
  tenantId: string,
  period: BillingPeriod
): Promise<Date | null> {
  const updated = await client.query<{ pro_until: Date }>(
    `update tenants
     set pro_until = greatest(coalesce(pro_until, now()), now()) + make_interval(days => $2::int)
     where id = $1
     returning pro_until`,
    [tenantId, PRO_PRICES[period].days]
  );
  return updated.rows[0]?.pro_until ?? null;
}

export async function submitUpiPayment(
  tenantId: TenantId,
  userId: string,
  input: { period: BillingPeriod; utr: string }
): Promise<PaymentRow> {
  const price = PRO_PRICES[input.period];
  const utr = normalizeUtr(input.utr);
  if (!price) throw new PaymentError('Choose monthly or annual.');
  if (!utr) throw new PaymentError('The UTR is the 12-digit number in your UPI app’s receipt.');

  return tx(async (client) => {
    await requirePayer(client, tenantId, userId);
    // The tenant row serialises claims from the same workspace.
    await client.query(`select id from tenants where id = $1 for update`, [tenantId]);
    const waiting = await client.query(
      `select 1 from payments where tenant_id = $1 and status = 'pending'`,
      [tenantId]
    );
    if (waiting.rows.length > 0) {
      throw new PaymentError('A payment for this workspace is already waiting for confirmation.');
    }
    const inserted = await client.query<PaymentRow>(
      `insert into payments (tenant_id, created_by, method, period, amount_paise, utr)
       values ($1, $2, 'upi', $3, $4, $5)
       on conflict (utr) do nothing
       returning ${COLUMNS}`,
      [tenantId, userId, input.period, price.paise, utr]
    );
    const row = inserted.rows[0];
    if (!row) throw new PaymentError('That UTR has already been submitted.');
    return row;
  });
}

/** The workspace's most recent payment, to show its status on the pricing page. */
export async function latestPayment(tenantId: TenantId): Promise<PaymentRow | null> {
  const [row] = await query<PaymentRow>(
    `select ${COLUMNS} from payments
     where tenant_id = $1 and status <> 'created'
     order by created_at desc limit 1`,
    [tenantId]
  );
  return row ?? null;
}

export interface PaymentReviewRow extends PaymentRow {
  tenant_name: string;
  submitted_by: string | null;
}

/**
 * Payments across every workspace, for SpecFix's own team only: the caller must check that.
 * Like listMembershipsForUser, this is deliberately not tenant-scoped; it is the operator's
 * view of the money coming in. Waiting payments first, then the most recent decisions.
 */
export async function listPaymentsForReview(limit = 50): Promise<PaymentReviewRow[]> {
  return query<PaymentReviewRow>(
    `select p.id, p.tenant_id, p.method, p.period, p.amount_paise, p.utr,
            p.razorpay_payment_id, p.status, p.created_at, p.decided_at,
            t.name as tenant_name, u.email as submitted_by
     from payments p
     join tenants t on t.id = p.tenant_id
     left join auth.users u on u.id = p.created_by
     where p.status <> 'created'
     order by (p.status = 'pending') desc, p.created_at desc
     limit $1`,
    [limit]
  );
}

/**
 * Approves or rejects a waiting payment. Approving extends Pro; a payment already decided is
 * refused, so a repeated click never extends Pro twice. Returns the new end of Pro, if any.
 */
export async function decidePayment(
  paymentId: string,
  deciderId: string,
  decision: 'paid' | 'rejected',
  /** Approving a UPI claim needs the code the team read in the bank note. */
  noteCode?: string
): Promise<{ proUntil: Date | null }> {
  return tx(async (client) => {
    const found = await client.query<{
      tenant_id: string;
      period: BillingPeriod;
      status: string;
      method: string;
      created_by: string | null;
    }>(
      `select tenant_id, period, status, method, created_by from payments where id = $1 for update`,
      [paymentId]
    );
    const payment = found.rows[0];
    if (!payment) throw new PaymentError('No such payment.');
    if (payment.status !== 'pending') throw new PaymentError('This payment was already decided.');
    if (decision === 'paid' && payment.method === 'upi') {
      const typed = normalizePayerCode(noteCode);
      if (!typed) throw new PaymentError('Type the P-… code from the bank note to approve.');
      if (!payment.created_by || typed !== payerCode(payment.created_by)) {
        throw new PaymentError(
          'The code in the bank note is not from the account that claimed this payment. Reject it.'
        );
      }
    }

    await client.query(
      `update payments set status = $2, decided_by = $3, decided_at = now() where id = $1`,
      [paymentId, decision, deciderId]
    );
    if (decision === 'rejected') return { proUntil: null };

    return { proUntil: await extendPro(client, payment.tenant_id, payment.period) };
  });
}

/**
 * Records a Razorpay order the server just created at the price for `period`. Owners and
 * admins only, re-checked here.
 */
export async function recordRazorpayOrder(
  tenantId: TenantId,
  userId: string,
  input: { period: BillingPeriod; orderId: string }
): Promise<PaymentRow> {
  const price = PRO_PRICES[input.period];
  if (!price) throw new PaymentError('Choose monthly or annual.');
  return tx(async (client) => {
    await requirePayer(client, tenantId, userId);
    const inserted = await client.query<PaymentRow>(
      `insert into payments
         (tenant_id, created_by, method, period, amount_paise, razorpay_order_id, status)
       values ($1, $2, 'razorpay', $3, $4, $5, 'created')
       returning ${COLUMNS}`,
      [tenantId, userId, input.period, price.paise, input.orderId]
    );
    return inserted.rows[0]!;
  });
}

/**
 * Marks a Razorpay order paid and extends Pro, once. The caller has already checked Razorpay's
 * signature. From the browser, `tenantId` is the session's workspace, so an order of another
 * workspace is refused; a webhook passes the amount Razorpay charged, which must match.
 * Confirming the same payment again is not an error: the browser and the webhook both arrive.
 */
export async function confirmRazorpayPayment(input: {
  orderId: string;
  paymentId: string;
  tenantId?: TenantId;
  amountPaise?: number;
}): Promise<{ proUntil: Date | null; already: boolean }> {
  return tx(async (client) => {
    const found = await client.query<{
      id: string;
      tenant_id: string;
      period: BillingPeriod;
      amount_paise: number;
      status: string;
      razorpay_payment_id: string | null;
    }>(
      `select id, tenant_id, period, amount_paise, status, razorpay_payment_id
       from payments where razorpay_order_id = $1 for update`,
      [input.orderId]
    );
    const order = found.rows[0];
    if (!order || (input.tenantId !== undefined && order.tenant_id !== input.tenantId)) {
      throw new PaymentError('Unknown order.');
    }
    if (input.amountPaise !== undefined && input.amountPaise !== order.amount_paise) {
      throw new PaymentError('The amount paid does not match the order.');
    }
    if (order.status === 'paid') {
      if (order.razorpay_payment_id !== input.paymentId) {
        throw new PaymentError('This order was already paid.');
      }
      const current = await client.query<{ pro_until: Date | null }>(
        `select pro_until from tenants where id = $1`,
        [order.tenant_id]
      );
      return { proUntil: current.rows[0]?.pro_until ?? null, already: true };
    }
    if (order.status !== 'created') throw new PaymentError('This order cannot be paid.');

    await client.query(
      `update payments set status = 'paid', razorpay_payment_id = $2, decided_at = now()
       where id = $1`,
      [order.id, input.paymentId]
    );
    return { proUntil: await extendPro(client, order.tenant_id, order.period), already: false };
  });
}
