import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  RazorpayError,
  createRazorpayOrder,
  parseRazorpayWebhook,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from '../src/index.ts';

const sign = (secret: string, text: string) =>
  createHmac('sha256', secret).update(text).digest('hex');

describe('Razorpay checks', () => {
  const secret = 'test_key_secret';

  it('accepts the Checkout signature for this order and payment only', () => {
    const signature = sign(secret, 'order_A1|pay_B2');
    const ok = { orderId: 'order_A1', paymentId: 'pay_B2', signature };
    expect(verifyRazorpayPaymentSignature(ok, secret)).toBe(true);
    expect(
      verifyRazorpayPaymentSignature({ ...ok, signature: signature.toUpperCase() }, secret)
    ).toBe(true);
    expect(verifyRazorpayPaymentSignature({ ...ok, orderId: 'order_OTHER' }, secret)).toBe(false);
    expect(verifyRazorpayPaymentSignature({ ...ok, paymentId: 'pay_OTHER' }, secret)).toBe(false);
    expect(verifyRazorpayPaymentSignature(ok, 'another_secret')).toBe(false);
    for (const bad of [undefined, null, '', 'zz', signature.slice(1), `${signature}00`]) {
      expect(verifyRazorpayPaymentSignature({ ...ok, signature: bad }, secret)).toBe(false);
    }
  });

  it('checks a webhook signature against the exact raw body', () => {
    const body = '{"event":"payment.captured"}';
    expect(verifyRazorpayWebhookSignature(body, sign('wh', body), 'wh')).toBe(true);
    expect(verifyRazorpayWebhookSignature(`${body} `, sign('wh', body), 'wh')).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, sign('other', body), 'wh')).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, null, 'wh')).toBe(false);
  });

  it('reads only the payment out of a webhook, and nothing from junk', () => {
    const event = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_1', order_id: 'order_1', amount: 1500, status: 'captured', x: 1 },
        },
      },
    };
    expect(parseRazorpayWebhook(event)).toEqual({
      event: 'payment.captured',
      orderId: 'order_1',
      paymentId: 'pay_1',
      amountPaise: 1500,
      status: 'captured',
    });
    expect(parseRazorpayWebhook({ event: 'refund.created', payload: {} })).toBeNull();
    expect(parseRazorpayWebhook('nope')).toBeNull();
    const injected = structuredClone(event);
    injected.payload.payment.entity.order_id = "order_1' or 1=1";
    expect(parseRazorpayWebhook(injected)).toBeNull();
  });

  it('creates an order with Basic auth and the given amount', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'order_Abc123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const id = await createRazorpayOrder(
      { keyId: 'rzp_test_k', keySecret: 's' },
      { amountPaise: 1500, receipt: 'r', notes: { tenant: 't' } },
      fakeFetch
    );
    expect(id).toBe('order_Abc123');
    expect(seen!.url).toBe('https://api.razorpay.com/v1/orders');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('rzp_test_k:s').toString('base64')}`
    );
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ amount: 1500, currency: 'INR' });
  });

  it('turns Razorpay failures into a readable error', async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const keys = { keyId: 'k', keySecret: 's' };
    const input = { amountPaise: 1500, receipt: 'r', notes: {} };
    await expect(createRazorpayOrder(keys, input, answer(401, {}))).rejects.toThrow(/API keys/);
    await expect(createRazorpayOrder(keys, input, answer(500, {}))).rejects.toThrow(RazorpayError);
    await expect(createRazorpayOrder(keys, input, answer(200, { id: 'evil' }))).rejects.toThrow(
      /unexpected/
    );
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(createRazorpayOrder(keys, input, down)).rejects.toThrow(/Could not reach/);
  });
});
