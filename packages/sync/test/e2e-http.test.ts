/**
 * End-to-end over real HTTP: a production build of the web app (`next start`) talking to
 * the disposable test database. Exercises what calling route handlers directly cannot —
 * Next's routing and middleware, real request bodies (including chunked uploads), status
 * codes as a client sees them — plus a load pass with many concurrent clients.
 *
 * Opt-in: needs SPECFIX_E2E_URL (e.g. http://localhost:3100) pointing at a server started
 * with DATABASE_URL = the test database, and SPECFIX_TEST_DATABASE_URL for seeding.
 * GITHUB_WEBHOOK_SECRET, when set for both, enables the GitHub webhook block.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  addMembership,
  closePool,
  createCiToken,
  createProject,
  createTenant,
  ingestTicket,
  query,
  saveGithubInstallation,
  recordRazorpayOrder,
  setGithubRepoProject,
} from '@specfix/db';
import { signGithubBody } from '@specfix/ingest';

const BASE = process.env.SPECFIX_E2E_URL?.replace(/\/$/, '');
const enabled = Boolean(BASE && process.env.SPECFIX_TEST_DATABASE_URL);
const GH_SECRET = process.env.GITHUB_WEBHOOK_SECRET?.trim();
const RAZORPAY_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();

afterAll(async () => {
  if (enabled) await closePool();
});

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

describe.skipIf(!enabled)('E2E over HTTP', () => {
  const label = `e2e-${Date.now()}`;
  let tenantId: string;
  let projectId: string;
  let token: string;
  let ownerId: string;
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
    ownerId = user!.id;
    rzpOrder = `order_e2e${Date.now()}`;
    await recordRazorpayOrder(tenantId, user!.id, { period: 'monthly', orderId: rzpOrder });
    projectId = (await createProject(tenantId, { name: 'Cart', sourceType: 'file' })).id;
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
      '/activate',
      '/join',
      '/join?find=%27%20or%201=1--',
      '/onboarding?new=1',
      '/projects',
      '/settings/security',
      '/login/verify',
      '/auth/callback',
      '/auth/callback?code=forged',
      '/projects/00000000-0000-4000-8000-000000000000',
      '/projects/00000000-0000-4000-8000-000000000000/board',
      '/projects/00000000-0000-4000-8000-000000000000/backlog',
      '/projects/00000000-0000-4000-8000-000000000000/list',
      '/projects/00000000-0000-4000-8000-000000000000/settings',
      '/projects/00000000-0000-4000-8000-000000000000/tasks/new',
      '/projects/00000000-0000-4000-8000-000000000000/calendar',
      '/projects/00000000-0000-4000-8000-000000000000/conversation',
      '/projects/00000000-0000-4000-8000-000000000000/people',
      '/projects/00000000-0000-4000-8000-000000000000/people?person=x%27%20or%201=1&role=admin',
      '/calendar',
      '/search?q=x',
      '/projects/00000000-0000-4000-8000-000000000000/tasks/1',
      '/attachments/00000000-0000-4000-8000-000000000000',
      "/attachments/x' or 1=1--",
    ])('redirects an anonymous visitor from %s to the landing page or sign-in', async (path) => {
      const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
      expect([302, 303, 307, 308]).toContain(r.status);
      const toSignIn = path.startsWith('/login') || path.startsWith('/auth/');
      const location = r.headers.get('location') ?? '';
      expect(new URL(location, BASE).pathname).toBe(toSignIn ? '/login' : '/');
    });

    // Behind a proxy request.url's origin is the server's bind address (https://0.0.0.0:8080),
    // so these redirects must stay relative to reach the browser's own host.
    it.each(['/auth/callback', '/auth/callback?code=forged'])(
      'sends %s back with a relative Location, never the server bind address',
      async (path) => {
        const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
        expect(r.headers.get('location') ?? '').toMatch(/^\/login\?error=/);
      }
    );

    it('serves the forgot-password page to anyone', async () => {
      const r = await fetch(`${BASE}/login/forgot`, { redirect: 'manual' });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Send reset link');
    });

    it('shows "link expired" on /login/reset without a reset session, never a password form', async () => {
      const r = await fetch(`${BASE}/login/reset`, { redirect: 'manual' });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('Link expired');
      expect(html).not.toContain('Save new password');
    });

    it.each([
      '/auth/callback?next=reset',
      '/auth/callback?next=reset&code=forged',
      `/auth/callback?next=reset&code=${'x'.repeat(600)}`,
    ])('sends a bad reset link %s to /login/forgot with a relative Location', async (path) => {
      const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
      expect([302, 303, 307, 308]).toContain(r.status);
      expect(r.headers.get('location') ?? '').toMatch(/^\/login\/forgot\?error=/);
    });

    it.each([
      '/auth/callback?next=//evil.example&code=forged',
      '/auth/callback?next=https://evil.example&code=forged',
    ])('never redirects off-site from %s', async (path) => {
      const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
      const location = r.headers.get('location') ?? '';
      expect(location).toMatch(/^\/login\?error=/);
      expect(location).not.toContain('evil');
    });

    // Next answers any form POST with no (or an unknown) server action id with a 500, on every
    // page with a form ("Failed to find Server Action"); /login has always done it too.
    it.fails.each(['/login', '/login/forgot'])(
      'BUG: a plain POST to %s without a server action id answers 500',
      async (path) => {
        const body = new FormData();
        body.set('email', `nobody-${Date.now()}@example.test`);
        const r = await fetch(`${BASE}${path}`, { method: 'POST', body, redirect: 'manual' });
        expect(r.status).toBeLessThan(500);
      }
    );

    it.each(['/login', '/login/forgot'])(
      'a plain POST to %s leaks no internal error text',
      async (path) => {
        const body = new FormData();
        body.set('email', `nobody-${Date.now()}@example.test`);
        const r = await fetch(`${BASE}${path}`, { method: 'POST', body, redirect: 'manual' });
        const text = await r.text();
        expect(text).not.toMatch(/Failed to find Server Action|at async|\.next[\\/]server/);
      }
    );

    it.each(['/api/jira/connect', '/api/jira/callback', `/api/jira/webhook/${randomUUID()}`])(
      'no longer serves the Jira route %s',
      async (path) => {
        const r = await fetch(`${BASE}${path}`, { method: 'GET', redirect: 'manual' });
        expect(r.status).toBe(404);
      }
    );

    it.each(['/api/github/install', '/api/github/callback?installation_id=1&code=x&state=y'])(
      'refuses %s without a session',
      async (path) => {
        const r = await fetch(`${BASE}${path}`, { redirect: 'manual' });
        expect(r.headers.get('location') ?? '').toMatch(/\/login/);
      }
    );
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

  describe.skipIf(!GH_SECRET)('GitHub webhook endpoint and PR runs', () => {
    const installationId = 100_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const repoId = 100_000_000 + Math.floor(Math.random() * 1_000_000_000);
    beforeAll(async () => {
      await saveGithubInstallation(tenantId, ownerId, {
        installationId,
        accountLogin: 'e2e',
        accountType: 'Organization',
        repositorySelection: 'selected',
        repos: [{ repoId, fullName: 'e2e/web', defaultBranch: 'main' }],
      });
      const [repo] = await query<{ id: string }>(
        `select id from github_repositories where repo_id = $1`,
        [repoId]
      );
      await setGithubRepoProject(tenantId, ownerId, repo!.id, projectId);
    });

    const prBody = (number: number, repo = repoId) =>
      JSON.stringify({
        action: 'opened',
        number,
        installation: { id: installationId },
        repository: { id: repo },
      });
    const gh = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${BASE}/api/github/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': signGithubBody(body, GH_SECRET!),
          ...headers,
        },
        body,
        redirect: 'manual',
      });
    const pending = async (number: number) =>
      (
        await query(
          `select 1 from sync_jobs where tenant_id = $1 and kind = 'github_pr_sync'
             and status = 'queued' and payload->>'number' = $2`,
          [tenantId, String(number)]
        )
      ).length;

    it('is not behind the session middleware: a signed delivery is accepted', async () => {
      const r = await gh(prBody(1));
      expect(r.status).toBe(202);
      expect(await r.text()).toBe('');
      expect(await pending(1)).toBe(1);
    });

    it('rejects a missing or forged signature with an empty 401', async () => {
      for (const sig of ['', signGithubBody(prBody(2), 'guess'), `sha256=${'0'.repeat(64)}`]) {
        const r = await gh(prBody(2), { 'x-hub-signature-256': sig });
        expect(r.status).toBe(401);
        expect(await r.text()).toBe('');
      }
      expect(await pending(2)).toBe(0);
    });

    it('drops a redelivery and ignores a repository the installation does not own', async () => {
      const id = randomUUID();
      expect((await gh(prBody(3), { 'x-github-delivery': id })).status).toBe(202);
      expect((await gh(prBody(3), { 'x-github-delivery': id })).status).toBe(204);
      expect((await gh(prBody(4, repoId + 1))).status).toBe(204);
      expect(await pending(4)).toBe(0);
    });

    it('a PR run (merge ref) does not change the default-branch status', async () => {
      const r = await ci(
        JSON.stringify({ commit: 'pr-sha', branch: '77/merge', report: report('unexpected') })
      );
      expect(r.status).toBe(201);
      const [row] = await query<{ on_default_branch: boolean }>(
        `select on_default_branch from ci_runs where tenant_id = $1 and commit_sha = 'pr-sha'`,
        [tenantId]
      );
      expect(row!.on_default_branch).toBe(false);
    });

    it('a burst of 300 deliveries for 10 PRs leaves one pending re-read per PR', async () => {
      const latencies: number[] = [];
      const statuses = await Promise.all(
        Array.from({ length: 300 }, async (_, i) => {
          const started = ms();
          const r = await gh(prBody(600 + (i % 10)));
          latencies.push(ms() - started);
          return r.status;
        })
      );
      console.log(
        `[load] github webhook x300: p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms`
      );
      expect(statuses.filter((s) => s !== 202)).toEqual([]);
      for (let n = 600; n < 610; n++) expect(await pending(n)).toBe(1);
    });
  });

  // Timing-dependent: a slow machine or a reset keep-alive socket can exceed vitest's 5 s.
  describe('load', { timeout: 30_000 }, () => {
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
    // Payment ids are unique across the database, so each run brings its own.
    const runId = Date.now();
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
      const body = event(rzpOrder, `pay_e2eWrong${runId}`);
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
      const unknown = event('order_e2eUnknown', `pay_e2eUnknown${runId}`);
      expect((await post(unknown, sign(unknown))).status).toBe(204);
      const cheap = event(rzpOrder, `pay_e2eCheap${runId}`, 100);
      expect((await post(cheap, sign(cheap))).status).toBe(204);
    });

    it('starts Pro once for a signed payment, and once more for nothing on replay', async () => {
      const body = event(rzpOrder, `pay_e2eGood${runId}`);
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
  describe('oversized bodies', { timeout: 30_000 }, () => {
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

    it.skipIf(!GH_SECRET)('rejects a GitHub webhook body over 1 MB', async () => {
      const body = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
      const outcome = await fetch(`${BASE}/api/github/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': signGithubBody(body, GH_SECRET!),
        },
        body,
      }).then(
        (r) => r.status,
        (error: { cause?: { code?: string } }) => error.cause?.code
      );
      expect([413, 'ECONNRESET', 'EPIPE']).toContain(outcome);
    });
  });
});
