import { NextResponse, type NextRequest } from 'next/server';
import { parseRazorpayWebhook, verifyRazorpayWebhookSignature } from '@specfix/ingest';
import { PaymentError, confirmRazorpayPayment } from '@/lib/repos';
import { readLimited } from '@/lib/read-limited';

/**
 * Razorpay webhook: confirms a paid order even when the payer closed the browser before the
 * Checkout could tell us. It needs a public HTTPS URL, so a localhost server never receives it.
 *
 * Nothing is trusted before X-Razorpay-Signature checks out against the raw body. Then only the
 * payment's order id, payment id and amount are read, and confirming is idempotent: the
 * browser and the webhook both arrive, and Razorpay retries, without extending Pro twice.
 *
 * Status codes matter to Razorpay: it retries anything but 2xx, so a permanent problem (bad
 * signature, an order that is not ours) answers 4xx or 2xx, never 5xx.
 */
const MAX_BODY_BYTES = 100_000;
const PAID_EVENTS = new Set(['payment.captured', 'order.paid']);

export async function POST(request: NextRequest) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) return new NextResponse(null, { status: 503 });

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return new NextResponse(null, { status: 413 });

  // The signature covers the raw body, so this is the first thing done with it.
  if (!verifyRazorpayWebhookSignature(raw, request.headers.get('x-razorpay-signature'), secret)) {
    return new NextResponse(null, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const payment = parseRazorpayWebhook(body);
  if (!payment || !PAID_EVENTS.has(payment.event)) return new NextResponse(null, { status: 204 });

  try {
    await confirmRazorpayPayment({
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      amountPaise: payment.amountPaise,
    });
  } catch (error) {
    // An order that is not ours, or a mismatched amount, will not change on a retry.
    if (error instanceof PaymentError) return new NextResponse(null, { status: 204 });
    throw error;
  }
  return new NextResponse(null, { status: 200 });
}
