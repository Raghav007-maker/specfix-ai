/**
 * End-to-end over real HTTP: a production build of the web app (`next start`) talking to
 * the disposable test database. Exercises what calling route handlers directly cannot —
 * Next's routing and middleware, real request bodies (including chunked uploads), status
 * codes as a client sees them — plus a load pass with many concurrent clients.
 *
 * Opt-in: needs SPECFIX_E2E_URL (e.g. http://localhost:3100) pointing at a server started
 * with DATABASE_URL = the test database, and SPECFIX_TEST_DATABASE_URL for seeding.
 * JIRA_CLIENT_SECRET (from .env) signs webhook JWTs exactly as the server verifies them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  addJiraProject,
  addMembership,
  closePool,
  createCiToken,
  createTenant,
  ingestTicket,
  query,
  recordRazorpayOrder,
  saveJiraGrant,
  setJiraSite,
} from '@specfix/db';

const BASE = process.env.SPECFIX_E2E_URL?.replace(/\/$/, '');
const SECRET = process.env.JIRA_CLIENT_SECRET?.trim();
const enabled = Boolean(BASE && process.env.SPECFIX_TEST_DATABASE_URL && SECRET);
const RAZORPAY_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();

afterAll(async () => {
  if (enabled) await closePool();
});

function jwt(secret: string, claims: Record<string, unknown> = {}): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

describe.skipIf(!enabled)('E2E over HTTP', () => {
  const label = `e2e-${Date.now()}`;
  let tenantId: string;
  let projectId: string;
  let connectionId: string;
  let token: string;
  let rzpOrder: string;
  const scenarios: string[] = [];

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    tenantId = (await createTenant(label)).id;
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}@example.test`]
    );
    await addMembership(tenantId, user!.id, 'owner');
    rzpOrder = `order_e2e${Date.now()}`;
    await recordRazorpayOrder(tenantId, user!.id, { period: 'monthly', orderId: rzpOrder });
    await saveJiraGrant(tenantId, user!.id, 'read', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['read:jira-work'],
    });
    await setJiraSite(tenantId, user!.id, {
      cloudId: `cloud-${label}`,
      siteUrl: 'https://e2e.atlassian.net',
      siteName: 'E2E',
    });
    projectId = (await addJiraProject(tenantId, user!.id, { projectKey: 'CART', name: 'Cart' })).id;
    const [conn] = await query<{ id: string }>(
      `select id from jira_connections where tenant_id = $1 and grant_kind = 'read'`,
      [tenantId]
    );
    connectionId = conn!.id;
    token = await createCiToken(tenantId, user!.id, projectId);

    const t = await ingestTicket(tenantId, projectId, {
      externalId: '1',
      externalKey: 'CART-1',
      title: 'Limit cart quantity',
      descriptionText: 'x',
      acceptanceCriteriaText: '- Max 99',
      raw: null,
      sourceUpdatedAt: null,
    });
    for (let i = 0; i < 50; i++) {
      const [s] = await query<{ id: string }>(
        `insert into scenarios (tenant_id, ticket_id, ticket_version_id, title, gherkin_raw, status, dedupe_key)
         values ($1, $2, $3, $4, 'Scenario: x', 'approved', $4) returning id`,
        [tenantId, t.ticket.id, t.version.id, `scenario ${i}`]
      );
      scenarios.push(s!.id);
    }
  });

  const report = (status: string, ids = scenarios) => ({
    suites: [
      {
        specs: ids.map((id) => ({
          title: 't',
          tags: [`@sf-${id}`],
          tests: [{ status, results: [{ duration: 5 }] }],
        })),
      },
    ],
  });
  const ci = (
    body: string | ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
    init: RequestInit = {}
  ) =>
    fetch(`${BASE}/api/ci/results`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body,
      redirect: 'manual',
      ...init,
    });
  const hook = (body: unknown, headers: Record<string, string> = {}, conn = connectionId) =>
    fetch(`${BASE}/api/jira/webhook/${conn}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt(SECRET!)}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  const delivery = (issueId: string, site = 'https://e2e.atlassian.net') => ({
    webhookEvent: 'jira:issue_updated',
    issue: { id: issueId, key: `CART-${issueId}`, self: `${site}/rest/api/3/issue/${issueId}` },
  });

  describe('pages and auth', () => {
    it('serves the login page', async () => {
      const r = await fetch(`${BASE}/login`, { redirect: 'manual' });
      expect(r.status).toBe(200);
    });

    it('shows the public landing page at / to anonymous visitors', async () => {
      const r = await fetch(`${BASE}/`, { redirect: 'manual' });
      expect(r.status).toBe(200);
    });

    it.each([
      '/settings/integrations',
      '/inbox',
      '/team',
      '/analytics',
      '/pricing',
      '/admin/payments',
    ])('redirects an anonymous visitor from %s to /login', async (path) => {
      const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
      expect([302, 303, 307, 308]).toContain(r.status);
      expect(r.headers.get('location') ?? '').toMatch(/\/login/);
    });

    it('refuses /api/jira/connect without a session', async () => {
      const r = await fetch(`${BASE}/api/jira/connect`, { redirect: 'manual' });
      expect(r.headers.get('location') ?? '').toMatch(/\/login/);
    });
  });

  describe('CI results endpoint', () => {
    it('rejects a missing, malformed or unknown token with the same 401', async () => {
      const bodies = await Promise.all(
        ['', 'Bearer nope', `Bearer sfci_${'x'.repeat(43)}`].map(async (h) => {
          const r = await ci('{}', { authorization: h });
          return [r.status, await r.text()];
        })
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]![0]).toBe(401);
    });

    it('stores a real report and answers 201 with counts', async () => {
      const r = await ci(
        JSON.stringify({ commit: 'abc1234', branch: 'main', report: report('expected') })
      );
      expect(r.status).toBe(201);
      expect(await r.json()).toMatchObject({ matched: 50, unmatched: 0 });
    });

    it('answers 400 with fixed messages for bad bodies', async () => {
      for (const body of ['not json', 'null', '[]', '{"suites":"x"}']) {
        const r = await ci(body);
        expect(r.status).toBe(400);
        expect(JSON.stringify(await r.json())).not.toMatch(/Cannot read|TypeError|at /);
      }
    });

    it('stores a report with NUL bytes and an Infinity duration instead of failing', async () => {
      const raw = `{"suites":[{"specs":[{"tags":["@sf-${scenarios[0]}"],"tests":[{"status":"unexpected","results":[{"duration":1e400,"error":{"message":"bad \\u0000 byte"}}]}]}]}]}`;
      const r = await ci(raw);
      expect(r.status).toBe(201);
    });
  });

  describe('Jira webhook endpoint', () => {
    it('rejects no JWT, a JWT signed with another secret, and an expired one', async () => {
      for (const auth of [
        '',
        `Bearer ${jwt('wrong-secret')}`,
        `Bearer ${jwt(SECRET!, { exp: 1 })}`,
      ]) {
        const r = await hook(delivery('100'), { authorization: auth });
        expect(r.status).toBe(401);
      }
    });

    it('404s an unknown connection even with a valid JWT', async () => {
      expect((await hook(delivery('100'), {}, randomUUID())).status).toBe(404);
    });

    it('queues one re-read per delivery and drops Jira retries', async () => {
      const id = `del-${label}`;
      expect((await hook(delivery('101'), { 'x-atlassian-webhook-identifier': id })).status).toBe(
        202
      );
      expect((await hook(delivery('101'), { 'x-atlassian-webhook-identifier': id })).status).toBe(
        204
      );
      const jobs = await query(
        `select 1 from sync_jobs where tenant_id = $1 and kind = 'jira_issue_sync' and payload->>'issueId' = '101'`,
        [tenantId]
      );
      expect(jobs).toHaveLength(1);
    });

    it('ignores a delivery for an issue on another site', async () => {
      const r = await hook(delivery('102', 'https://other.atlassian.net'));
      expect(r.status).toBe(204);
    });
  });

  describe('load', () => {
    it('200 concurrent CI uploads all succeed, each stored once', async () => {
      const before = await query<{ n: number }>(
        `select count(*)::int n from ci_runs where tenant_id = $1`,
        [tenantId]
      );
      const latencies: number[] = [];
      const statuses = await Promise.all(
        Array.from({ length: 200 }, async (_, i) => {
          const started = ms();
          const r = await ci(
            JSON.stringify({
              commit: `load${i}`,
              report: report(i % 7 === 0 ? 'unexpected' : 'expected'),
            })
          );
          latencies.push(ms() - started);
          return r.status;
        })
      );
      const after = await query<{ n: number }>(
        `select count(*)::int n from ci_runs where tenant_id = $1`,
        [tenantId]
      );
      console.log(
        `[load] CI x200 (50 scenarios each): p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${Math.max(...latencies)}ms`
      );
      expect(statuses.filter((s) => s !== 201)).toEqual([]);
      expect(after[0]!.n - before[0]!.n).toBe(200);
    });

    it('a burst of 300 webhook deliveries for 10 issues leaves one pending re-read per issue', async () => {
      const latencies: number[] = [];
      const statuses = await Promise.all(
        Array.from({ length: 300 }, async (_, i) => {
          const started = ms();
          const r = await hook(delivery(String(500 + (i % 10))), {
            'x-atlassian-webhook-identifier': `burst-${label}-${i}`,
          });
          latencies.push(ms() - started);
          return r.status;
        })
      );
      console.log(
        `[load] webhook x300: p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms max=${Math.max(...latencies)}ms`
      );
      expect(statuses.filter((s) => s !== 202)).toEqual([]);
      const pending = await query<{ issue: string; n: number }>(
        `select payload->>'issueId' issue, count(*)::int n from sync_jobs
         where tenant_id = $1 and kind = 'jira_issue_sync' and status = 'queued'
           and (payload->>'issueId')::int between 500 and 509
         group by 1`,
        [tenantId]
      );
      expect(pending).toHaveLength(10);
      expect(pending.every((p) => p.n === 1)).toBe(true);
    });

    it('100 concurrent anonymous page loads all redirect cleanly', async () => {
      const statuses = await Promise.all(
        Array.from({ length: 100 }, () =>
          fetch(`${BASE}/inbox`, { redirect: 'manual' }).then((r) => r.status)
        )
      );
      expect(statuses.every((s) => s >= 300 && s < 400)).toBe(true);
    });
  });

  describe.skipIf(!RAZORPAY_SECRET)('Razorpay webhook', () => {
    const url = () => `${BASE}/api/payments/razorpay/webhook`;
    const event = (orderId: string, paymentId: string, amount = 1500) =>
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: paymentId, order_id: orderId, amount, status: 'captured' } },
        },
      });
    const post = (body: string, signature: string | null) =>
      fetch(url(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature ? { 'x-razorpay-signature': signature } : {}),
        },
        body,
      });
    const sign = (body: string, secret = RAZORPAY_SECRET!) =>
      createHmac('sha256', secret).update(body).digest('hex');

    it('rejects a missing or wrong signature, and changes nothing', async () => {
      const body = event(rzpOrder, 'pay_e2eWrong');
      expect((await post(body, null)).status).toBe(401);
      expect((await post(body, sign(body, 'not-the-secret'))).status).toBe(401);
      expect((await post(body, sign(`${body} `))).status).toBe(401);
      const [row] = await query<{ status: string }>(
        `select status from payments where razorpay_order_id = $1`,
        [rzpOrder]
      );
      expect(row?.status).toBe('created');
    });

    it('ignores a signed event for an order that is not ours, or a wrong amount', async () => {
      const unknown = event('order_e2eUnknown', 'pay_e2eUnknown');
      expect((await post(unknown, sign(unknown))).status).toBe(204);
      const cheap = event(rzpOrder, 'pay_e2eCheap', 100);
      expect((await post(cheap, sign(cheap))).status).toBe(204);
    });

    it('starts Pro once for a signed payment, and once more for nothing on replay', async () => {
      const body = event(rzpOrder, 'pay_e2eGood');
      const statuses = await Promise.all(
        Array.from({ length: 5 }, () => post(body, sign(body)).then((r) => r.status))
      );
      expect(statuses.every((s) => s === 200)).toBe(true);
      const [row] = await query<{ status: string; pro_until: Date }>(
        `select p.status, t.pro_until from payments p join tenants t on t.id = p.tenant_id
         where p.razorpay_order_id = $1`,
        [rzpOrder]
      );
      expect(row?.status).toBe('paid');
      expect(Math.round((row!.pro_until.getTime() - Date.now()) / 86_400_000)).toBe(30);
    });
  });

  // Last on purpose: the server answers 413 without draining the body, which resets the
  // client's keep-alive connection, so nothing may run after these on the same client.
  describe('oversized bodies', () => {
    it('stops a chunked upload past 5 MB without a Content-Length', async () => {
      const chunk = new TextEncoder().encode('x'.repeat(1_000_000));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent++ >= 8) return c.close();
          c.enqueue(chunk);
        },
      });
      const r = await ci(stream, {}, { duplex: 'half' } as RequestInit);
      expect(r.status).toBe(413);
    });

    it('rejects a declared Content-Length over 5 MB before reading', async () => {
      const r = await ci('x'.repeat(5_100_000));
      expect(r.status).toBe(413);
    });

    it('rejects a webhook body over 1 MB, and queues nothing', async () => {
      // The server answers before the upload finishes, so the client sees either the 413
      // or a reset connection; both mean the delivery was refused.
      const outcome = await hook({ ...delivery('103'), pad: 'x'.repeat(1_100_000) }).then(
        (r) => r.status,
        (error: { cause?: { code?: string } }) => error.cause?.code
      );
      expect([413, 'ECONNRESET', 'EPIPE']).toContain(outcome);
      const jobs = await query(
        `select 1 from sync_jobs where tenant_id = $1 and payload->>'issueId' = '103'`,
        [tenantId]
      );
      expect(jobs).toHaveLength(0);
    });
  });
});
