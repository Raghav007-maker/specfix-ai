/**
 * Razorpay, for Pro payments: create an order, and check what comes back.
 *
 * From Razorpay's docs:
 *   - An order is created server-side with Basic auth (key id : key secret); the browser
 *     Checkout then pays that order and hands back razorpay_order_id, razorpay_payment_id
 *     and razorpay_signature.
 *   - That signature is HMAC-SHA256 of "<order_id>|<payment_id>" with the key secret.
 *   - Webhooks carry X-Razorpay-Signature: HMAC-SHA256 of the raw body with the webhook
 *     secret. A localhost server cannot receive them; the Checkout signature covers that case.
 * The body of a webhook is untrusted until its signature checks out, and even then only the
 * fields read here are used.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const API = 'https://api.razorpay.com/v1';

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
}

/** A refusal or failure talking to Razorpay. The message is safe to show. */
export class RazorpayError extends Error {}

function hmacHex(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex strings; false for anything malformed. */
function sameHex(expected: string, given: string | null | undefined): boolean {
  if (!given || !/^[0-9a-f]+$/i.test(given) || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given.toLowerCase(), 'hex'));
}

/** The Checkout handler's signature: proves Razorpay paid this order with this payment. */
export function verifyRazorpayPaymentSignature(
  input: { orderId: string; paymentId: string; signature: string | null | undefined },
  keySecret: string
): boolean {
  return sameHex(hmacHex(keySecret, `${input.orderId}|${input.paymentId}`), input.signature);
}

/** A webhook's X-Razorpay-Signature over the raw request body. */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  webhookSecret: string
): boolean {
  return sameHex(hmacHex(webhookSecret, rawBody), signature);
}

const OrderResponse = z.object({ id: z.string().regex(/^order_[A-Za-z0-9]+$/) });

/** Creates an order for `amountPaise`; returns its id. The amount comes from our price list. */
export async function createRazorpayOrder(
  keys: RazorpayKeys,
  input: { amountPaise: number; receipt: string; notes: Record<string, string> },
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64');
  let response: Response;
  try {
    response = await fetchImpl(`${API}/orders`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: 'INR',
        receipt: input.receipt.slice(0, 40),
        notes: input.notes,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RazorpayError('Could not reach Razorpay. Please try again.');
  }
  if (!response.ok) {
    throw new RazorpayError(
      response.status === 401
        ? 'Razorpay rejected the API keys. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.'
        : 'Razorpay could not create the order. Please try again.'
    );
  }
  const parsed = OrderResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new RazorpayError('Razorpay answered with an unexpected order.');
  return parsed.data.id;
}

const PaymentEntity = z.object({
  id: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  order_id: z.string().regex(/^order_[A-Za-z0-9]+$/),
  amount: z.number().int().positive(),
  status: z.string(),
});

const Webhook = z.object({
  event: z.string(),
  payload: z.object({ payment: z.object({ entity: PaymentEntity }) }),
});

export interface RazorpayPaymentEvent {
  event: string;
  orderId: string;
  paymentId: string;
  amountPaise: number;
  status: string;
}

/** The payment in a webhook, or null for anything else (a different event shape, junk). */
export function parseRazorpayWebhook(body: unknown): RazorpayPaymentEvent | null {
  const parsed = Webhook.safeParse(body);
  if (!parsed.success) return null;
  const p = parsed.data.payload.payment.entity;
  return {
    event: parsed.data.event,
    orderId: p.order_id,
    paymentId: p.id,
    amountPaise: p.amount,
    status: p.status,
  };
}
