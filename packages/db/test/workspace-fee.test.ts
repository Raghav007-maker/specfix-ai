/**
 * A new workspace opens after its one-time fee, and a workspace takes a limited number of admins
 * and reviewers (Free 5, Pro 10; owners are not counted). Skipped without
 * SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKSPACE_FEE_PAISE, payerCode } from '@specfix/shared';
import {
  MembershipError,
  PaymentError,
  RequestError,
  addMemberByEmail,
  closePool,
  confirmRazorpayPayment,
  createWorkspace,
  decideJoinRequest,
  decidePayment,
  listJoinRequests,
  listMembershipsForUser,
  query,
  recordRazorpayOrder,
  requestToJoin,
  searchTeams,
  setProUntil,
  submitUpiPayment,
  tenantPlan,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('workspace fee and seat limits', () => {
  const label = `wf${Date.now()}`;
  let seq = 0;
  const utr = () => `${Date.now()}`.slice(-9) + String(seq++).padStart(3, '0');
  const newUser = async (key: string) => {
    const [row] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-${key}@example.test`]
    );
    return row!.id;
  };
  let owner: string;
  let team: string;

  beforeAll(async () => {
    owner = await newUser('owner');
    team = await newUser('team');
  });

  const closedWorkspace = async (name: string) =>
    (
      await createWorkspace(
        owner,
        { tenantName: `${label} ${name}`, projectName: 'First' },
        { open: false }
      )
    ).id;

  it('starts a self-made workspace closed, and an existing-style one open', async () => {
    const closed = await closedWorkspace('closed');
    expect((await tenantPlan(closed)).open).toBe(false);
    const mine = await listMembershipsForUser(owner);
    expect(mine.find((m) => m.tenant_id === closed)).toMatchObject({ role: 'owner', open: false });
    const open = await createWorkspace(owner, { tenantName: `${label} open`, projectName: 'P' });
    expect((await tenantPlan(open.id)).open).toBe(true);
  });

  it('opens the workspace once the fee is approved, at the server price', async () => {
    const id = await closedWorkspace('upi');
    // Pro is not for sale before the workspace opens.
    await expect(submitUpiPayment(id, owner, { period: 'monthly', utr: utr() })).rejects.toThrow(
      /workspace fee first/
    );
    const row = await submitUpiPayment(id, owner, { period: 'workspace', utr: utr() });
    expect(row).toMatchObject({ period: 'workspace', amount_paise: WORKSPACE_FEE_PAISE });
    await decidePayment(row.id, team, 'paid', payerCode(owner));
    const plan = await tenantPlan(id);
    expect(plan).toMatchObject({ open: true, pro: false });
    // Paid once: the fee cannot be paid again, and Pro is now possible.
    await expect(submitUpiPayment(id, owner, { period: 'workspace', utr: utr() })).rejects.toThrow(
      /already open/
    );
    await submitUpiPayment(id, owner, { period: 'monthly', utr: utr() });
  });

  it('keeps a rejected fee closed', async () => {
    const id = await closedWorkspace('rejected');
    const row = await submitUpiPayment(id, owner, { period: 'workspace', utr: utr() });
    await decidePayment(row.id, team, 'rejected');
    expect((await tenantPlan(id)).open).toBe(false);
  });

  it('opens the workspace once when Razorpay confirms twice', async () => {
    const id = await closedWorkspace('rzp');
    const orderId = `order_${label}`;
    const paymentId = `pay_${label}`;
    await recordRazorpayOrder(id, owner, { period: 'workspace', orderId });
    const results = await Promise.allSettled([
      confirmRazorpayPayment({ orderId, paymentId, tenantId: id }),
      confirmRazorpayPayment({ orderId, paymentId, amountPaise: WORKSPACE_FEE_PAISE }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await tenantPlan(id)).open).toBe(true);
    const paid = await query(`select 1 from payments where tenant_id = $1 and status = 'paid'`, [
      id,
    ]);
    expect(paid).toHaveLength(1);
  });

  it('lets only the owner pay the fee', async () => {
    const id = await closedWorkspace('who');
    const stranger = await newUser('stranger');
    await expect(
      submitUpiPayment(id, stranger, { period: 'workspace', utr: utr() })
    ).rejects.toThrow(PaymentError);
  });

  it('hides a closed workspace from search and takes no join requests', async () => {
    const id = await closedWorkspace('Hidden Corp');
    const seeker = await newUser('seeker');
    expect((await searchTeams(seeker, `${label} Hidden`)).map((t) => t.id)).not.toContain(id);
    await expect(requestToJoin(seeker, id)).rejects.toThrow(RequestError);
  });

  describe('seat limits', () => {
    let ws: string;
    const people: string[] = [];

    beforeAll(async () => {
      ws = (await createWorkspace(owner, { tenantName: `${label} seats`, projectName: 'P' })).id;
      for (let i = 0; i < 12; i++) people.push(await newUser(`p${i}`));
    });

    it('takes five admins and reviewers on Free, owners not counted', async () => {
      for (let i = 0; i < 5; i++) {
        await addMemberByEmail(ws, owner, {
          email: `${label}-p${i}@example.test`,
          role: i === 0 ? 'admin' : 'reviewer',
        });
      }
      expect(await tenantPlan(ws)).toMatchObject({ memberCount: 5, memberLimit: 5 });
      await expect(
        addMemberByEmail(ws, owner, { email: `${label}-p5@example.test`, role: 'reviewer' })
      ).rejects.toThrow(MembershipError);
      await expect(
        addMemberByEmail(ws, owner, { email: `${label}-p5@example.test`, role: 'reviewer' })
      ).rejects.toThrow(/Free plan allows 5/);
      // SpecFix's own team is not limited.
      await addMemberByEmail(
        ws,
        owner,
        { email: `${label}-p5@example.test`, role: 'reviewer' },
        { unlimited: true }
      );
    });

    it('refuses an approval past the limit, and lets parallel approvals take the last seat once', async () => {
      await setProUntil(ws, new Date(Date.now() + 86_400_000));
      expect((await tenantPlan(ws)).memberLimit).toBe(10);
      // 6 seats used; four join requests for the 4 left, then two more race for none.
      for (let i = 6; i < 12; i++) await requestToJoin(people[i]!, ws);
      const requests = await listJoinRequests(ws, owner);
      expect(requests).toHaveLength(6);
      const results = await Promise.allSettled(
        requests.map((r) => decideJoinRequest(ws, owner, r.id, true))
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
      const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(refused.every((r) => /Pro plan allows 10/.test(String(r.reason)))).toBe(true);
      expect((await tenantPlan(ws)).memberCount).toBe(10);
    });
  });
});
