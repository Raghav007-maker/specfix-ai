/**
 * UPI payments: who may submit, one UTR once, one claim waiting per workspace, and approving
 * extends Pro by exactly one period even when it is clicked twice at once.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PaymentError,
  addMembership,
  closePool,
  confirmRazorpayPayment,
  createTenant,
  decidePayment,
  latestPayment,
  listPaymentsForReview,
  query,
  recordRazorpayOrder,
  setProUntil,
  submitUpiPayment,
  tenantPlan,
} from '../src/index.ts';
import { payerCode } from '@specfix/shared';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);
const DAY = 86_400_000;

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('UPI payments', () => {
  const label = `pay-${Date.now()}`;
  let seq = 0;
  // Unique 12-digit UTRs per run, so reruns on the same database never collide.
  const utr = () => `${Date.now()}`.slice(-9) + String(seq++).padStart(3, '0');
  const users = {} as Record<'owner' | 'admin' | 'reviewer' | 'outsider' | 'team', string>;

  async function workspace(suffix: string): Promise<string> {
    const id = (await createTenant(`${label}-${suffix}`)).id;
    await addMembership(id, users.owner, 'owner');
    await addMembership(id, users.admin, 'admin');
    await addMembership(id, users.reviewer, 'reviewer');
    return id;
  }

  beforeAll(async () => {
    for (const key of ['owner', 'admin', 'reviewer', 'outsider', 'team'] as const) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      users[key] = row!.id;
    }
  });

  it('records a claim at the server price, never a posted amount', async () => {
    const id = await workspace('price');
    const row = await submitUpiPayment(id, users.owner, { period: 'annual', utr: utr() });
    expect(row).toMatchObject({ status: 'pending', period: 'annual', amount_paise: 15000 });
    expect((await latestPayment(id))?.id).toBe(row.id);
  });

  it('lets owners and admins pay, not reviewers or outsiders', async () => {
    const a = await workspace('roles-a');
    const b = await workspace('roles-b');
    await expect(
      submitUpiPayment(a, users.reviewer, { period: 'monthly', utr: utr() })
    ).rejects.toThrow(PaymentError);
    await expect(
      submitUpiPayment(a, users.outsider, { period: 'monthly', utr: utr() })
    ).rejects.toThrow(PaymentError);
    await submitUpiPayment(b, users.admin, { period: 'monthly', utr: utr() });
    expect(await latestPayment(a)).toBeNull();
  });

  it('refuses a malformed UTR', async () => {
    const id = await workspace('bad-utr');
    for (const bad of ['', '123', 'abcdefghijkl', "412345678901'; drop table payments;--"]) {
      await expect(
        submitUpiPayment(id, users.owner, { period: 'monthly', utr: bad })
      ).rejects.toThrow(PaymentError);
    }
  });

  it('accepts a UTR once, in any workspace', async () => {
    const a = await workspace('dup-a');
    const b = await workspace('dup-b');
    const same = utr();
    await submitUpiPayment(a, users.owner, { period: 'monthly', utr: same });
    await expect(
      submitUpiPayment(b, users.owner, { period: 'monthly', utr: same })
    ).rejects.toThrow(/already been submitted/);
  });

  it('keeps one claim waiting per workspace', async () => {
    const id = await workspace('one-pending');
    await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    await expect(
      submitUpiPayment(id, users.admin, { period: 'monthly', utr: utr() })
    ).rejects.toThrow(/already waiting/);
  });

  it('starts Pro for 30 days on approval, and refuses a second decision', async () => {
    const id = await workspace('approve');
    const row = await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    const before = Date.now();
    const { proUntil } = await decidePayment(row.id, users.team, 'paid', payerCode(users.owner));
    const days = (proUntil!.getTime() - before) / DAY;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    expect((await tenantPlan(id)).pro).toBe(true);
    await expect(decidePayment(row.id, users.team, 'paid', payerCode(users.owner))).rejects.toThrow(
      /already decided/
    );
    await expect(decidePayment(row.id, users.team, 'rejected')).rejects.toThrow(/already decided/);
  });

  it('approves a UPI claim only with the claiming account’s code from the bank note', async () => {
    const id = await workspace('note-code');
    const row = await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    for (const bad of [undefined, '', payerCode(users.admin), 'W-ABCDEF', "P-' or 1=1 --"]) {
      await expect(decidePayment(row.id, users.team, 'paid', bad)).rejects.toThrow(PaymentError);
    }
    expect((await tenantPlan(id)).pro).toBe(false);
    const spaced = ` ${payerCode(users.owner).toLowerCase().replace('-', '- ')} `;
    expect((await decidePayment(row.id, users.team, 'paid', spaced)).proUntil).not.toBeNull();
  });

  it('extends from the current end of Pro, not from today', async () => {
    const id = await workspace('extend');
    const end = new Date(Date.now() + 10 * DAY);
    await setProUntil(id, end);
    const row = await submitUpiPayment(id, users.owner, { period: 'annual', utr: utr() });
    const { proUntil } = await decidePayment(row.id, users.team, 'paid', payerCode(users.owner));
    expect(Math.round((proUntil!.getTime() - end.getTime()) / DAY)).toBe(365);
  });

  it('restarts from today when Pro has already ended', async () => {
    const id = await workspace('lapsed');
    await setProUntil(id, new Date(Date.now() - 20 * DAY));
    const row = await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    const { proUntil } = await decidePayment(row.id, users.team, 'paid', payerCode(users.owner));
    expect(Math.round((proUntil!.getTime() - Date.now()) / DAY)).toBe(30);
  });

  it('leaves the plan alone on rejection, and frees the workspace to pay again', async () => {
    const id = await workspace('reject');
    const row = await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    expect(await decidePayment(row.id, users.team, 'rejected')).toEqual({ proUntil: null });
    expect((await tenantPlan(id)).pro).toBe(false);
    expect((await latestPayment(id))?.status).toBe('rejected');
    await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
  });

  it('lists waiting payments first for the team', async () => {
    const rows = await listPaymentsForReview(500);
    const firstDecided = rows.findIndex((r) => r.status !== 'pending');
    const lastPending = rows.map((r) => r.status).lastIndexOf('pending');
    if (firstDecided !== -1 && lastPending !== -1) expect(lastPending).toBeLessThan(firstDecided);
    expect(rows.find((r) => r.tenant_name === `${label}-price`)?.submitted_by).toBe(
      `${label}-owner@example.test`
    );
  });

  it('extends Pro exactly once when approved twice at the same time', async () => {
    const id = await workspace('race');
    const row = await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    const results = await Promise.allSettled([
      decidePayment(row.id, users.team, 'paid', payerCode(users.owner)),
      decidePayment(row.id, users.team, 'paid', payerCode(users.owner)),
      decidePayment(row.id, users.team, 'paid', payerCode(users.owner)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { proUntil } = await tenantPlan(id);
    expect(Math.round((proUntil!.getTime() - Date.now()) / DAY)).toBe(30);
  });

  it('never lets one workspace submit two claims at once', async () => {
    const id = await workspace('claim-race');
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PaymentError);
    }
  });

  describe('Razorpay', () => {
    let n = 0;
    const order = () => `order_${label.replace(/\W/g, '')}${n++}`;
    const pay = () => `pay_${label.replace(/\W/g, '')}${n++}`;

    it('records an order at the server price, hidden until paid', async () => {
      const id = await workspace('rzp-order');
      const row = await recordRazorpayOrder(id, users.admin, {
        period: 'annual',
        orderId: order(),
      });
      expect(row).toMatchObject({ method: 'razorpay', status: 'created', amount_paise: 15000 });
      expect(await latestPayment(id)).toBeNull();
      // An unpaid order blocks nothing: a UPI claim still goes through.
      await submitUpiPayment(id, users.owner, { period: 'monthly', utr: utr() });
    });

    it('lets only owners and admins start a payment', async () => {
      const id = await workspace('rzp-roles');
      for (const who of [users.reviewer, users.outsider]) {
        await expect(
          recordRazorpayOrder(id, who, { period: 'monthly', orderId: order() })
        ).rejects.toThrow(PaymentError);
      }
    });

    it('starts Pro once, even when the browser and the webhook both confirm', async () => {
      const id = await workspace('rzp-twice');
      const o = order();
      const p = pay();
      await recordRazorpayOrder(id, users.owner, { period: 'monthly', orderId: o });
      const first = await confirmRazorpayPayment({ orderId: o, paymentId: p, tenantId: id });
      expect(first.already).toBe(false);
      const again = await confirmRazorpayPayment({ orderId: o, paymentId: p, amountPaise: 1500 });
      expect(again).toEqual({ proUntil: first.proUntil, already: true });
      expect(Math.round((first.proUntil!.getTime() - Date.now()) / DAY)).toBe(30);
      expect((await latestPayment(id))?.status).toBe('paid');
      await expect(
        confirmRazorpayPayment({ orderId: o, paymentId: pay(), tenantId: id })
      ).rejects.toThrow(/already paid/);
    });

    it('refuses another workspace’s order, a wrong amount, and an unknown order', async () => {
      const mine = await workspace('rzp-mine');
      const other = await workspace('rzp-other');
      const o = order();
      await recordRazorpayOrder(mine, users.owner, { period: 'monthly', orderId: o });
      await expect(
        confirmRazorpayPayment({ orderId: o, paymentId: pay(), tenantId: other })
      ).rejects.toThrow(/Unknown order/);
      await expect(
        confirmRazorpayPayment({ orderId: o, paymentId: pay(), amountPaise: 100 })
      ).rejects.toThrow(/does not match/);
      await expect(confirmRazorpayPayment({ orderId: order(), paymentId: pay() })).rejects.toThrow(
        /Unknown order/
      );
      expect((await tenantPlan(mine)).pro).toBe(false);
    });

    it('extends Pro exactly once when confirmations race', async () => {
      const id = await workspace('rzp-race');
      const o = order();
      const p = pay();
      await recordRazorpayOrder(id, users.owner, { period: 'annual', orderId: o });
      const results = await Promise.all(
        Array.from({ length: 4 }, () => confirmRazorpayPayment({ orderId: o, paymentId: p }))
      );
      expect(results.filter((r) => !r.already)).toHaveLength(1);
      const { proUntil } = await tenantPlan(id);
      expect(Math.round((proUntil!.getTime() - Date.now()) / DAY)).toBe(365);
    });
  });
});
