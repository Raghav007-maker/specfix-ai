/**
 * GitHub App integration against the test database and an in-memory fake of GitHub's
 * REST API: installations and permissions, tenant isolation, the installation-token
 * cache, CI run placement (the default-branch fix), PR ↔ ticket linking, the "not ready"
 * comment, the acceptance check run, "Open PR with scaffolds", and the webhook route
 * handler called directly — including the attack and concurrency cases.
 *
 * The routes import `@/lib/repos`, mocked to @specfix/db as in ci-hardening.test.ts.
 * Needs SPECFIX_TEST_DATABASE_URL (a disposable database); skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  GithubConnectionError,
  addMembership,
  closePool,
  createProject,
  createTenant,
  decideScaffold,
  disconnectGithub,
  forgetGithubInstallationToken,
  getGithubInstallationToken,
  ingestTicket,
  installationForWebhook,
  latestCiForTicket,
  markReady,
  query,
  queueGithubSyncForTicket,
  recordCiRun,
  repositoryForWebhook,
  saveGithubInstallation,
  saveScaffold,
  setGithubInstallationSuspended,
  setGithubRepoProject,
  type JobRow,
} from '@specfix/db';
import { signGithubBody, type GithubAppConfig } from '@specfix/ingest';
import {
  PermanentJobError,
  openScaffoldPr,
  runGithubCheckRun,
  runGithubPrSync,
  type GithubDeps,
} from '@specfix/sync';

vi.mock('@/lib/repos', async () => await import('@specfix/db'));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/read-limited', async () => await import('../../../apps/web/lib/read-limited.ts'));

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);
const WEBHOOK_SECRET = 'test-webhook-secret';

afterAll(async () => {
  if (hasDatabase) await closePool();
});

type Post = (request: Request) => Promise<Response>;
const ROUTE = fileURLToPath(
  new URL('../../../apps/web/app/api/github/webhook/route.ts', import.meta.url)
);

// ---------------------------------------------------------------- fake GitHub

interface FakePull {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: 'open' | 'closed';
  merged: boolean;
  html_url: string;
}

class FakeGithub {
  calls: Array<{ method: string; path: string; body: unknown }> = [];
  tokensMinted = 0;
  pulls = new Map<number, FakePull>();
  comments = new Map<number, string>();
  commentsCreated = 0;
  checkRuns = new Map<number, { head_sha: string; conclusion: string; title: string }>();
  refs = new Map<string, string>([['main', 'sha-main']]);
  commits = new Map<string, string>([['sha-main', 'tree-main']]);
  trees = new Map<string, Array<{ path: string; content: string }>>();
  pullsCreated = 0;
  private nextId = 1000;

  fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // A little latency, so concurrent callers really overlap.
    await new Promise((r) => setTimeout(r, 5));
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    this.calls.push({ method, path: `${path}${url.search}`, body });
    const json = (status: number, value?: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), { status });
    let m: RegExpExecArray | null;

    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path))) {
      this.tokensMinted += 1;
      return json(201, {
        token: `ghs_fake_${this.tokensMinted}`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (path === '/installation/repositories') return json(200, { repositories: [] });
    if ((m = /^\/repos\/acme\/web\/pulls\/(\d+)$/.exec(path)) && method === 'GET') {
      const pull = this.pulls.get(Number(m[1]));
      return pull ? json(200, pull) : json(404);
    }
    if (path === '/repos/acme/web/pulls' && method === 'GET') {
      const head = url.searchParams.get('head')?.split(':')[1];
      return json(
        200,
        [...this.pulls.values()].filter((p) => p.head.ref === head && p.state === 'open')
      );
    }
    if (path === '/repos/acme/web/pulls' && method === 'POST') {
      this.pullsCreated += 1;
      const number = 900 + this.pullsCreated;
      const pull: FakePull = {
        number,
        title: body.title,
        body: body.body,
        head: { ref: body.head, sha: this.refs.get(body.head) ?? 'unknown' },
        base: { ref: body.base },
        state: 'open',
        merged: false,
        html_url: `https://github.com/acme/web/pull/${number}`,
      };
      this.pulls.set(number, pull);
      return json(201, pull);
    }
    if ((m = /^\/repos\/acme\/web\/issues\/(\d+)\/comments$/.exec(path))) {
      const id = this.nextId++;
      this.comments.set(id, body.body);
      this.commentsCreated += 1;
      return json(201, { id });
    }
    if ((m = /^\/repos\/acme\/web\/issues\/comments\/(\d+)$/.exec(path))) {
      const id = Number(m[1]);
      if (!this.comments.has(id)) return json(404, { message: 'Not Found' });
      this.comments.set(id, body.body);
      return json(200, { id });
    }
    if (path === '/repos/acme/web/check-runs' && method === 'POST') {
      const id = this.nextId++;
      this.checkRuns.set(id, {
        head_sha: body.head_sha,
        conclusion: body.conclusion,
        title: body.output.title,
      });
      return json(201, { id });
    }
    if ((m = /^\/repos\/acme\/web\/check-runs\/(\d+)$/.exec(path))) {
      const run = this.checkRuns.get(Number(m[1]))!;
      this.checkRuns.set(Number(m[1]), {
        ...run,
        conclusion: body.conclusion,
        title: body.output.title,
      });
      return json(200, {});
    }
    if ((m = /^\/repos\/acme\/web\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const sha = this.refs.get(decodeURIComponent(m[1]!));
      return sha ? json(200, { object: { sha } }) : json(404);
    }
    if ((m = /^\/repos\/acme\/web\/git\/commits\/(.+)$/.exec(path))) {
      return json(200, { tree: { sha: this.commits.get(m[1]!) } });
    }
    if (path === '/repos/acme/web/git/trees') {
      const sha = `tree-${this.nextId++}`;
      this.trees.set(sha, body.tree);
      return json(201, { sha });
    }
    if (path === '/repos/acme/web/git/commits') {
      const sha = `commit-${this.nextId++}`;
      this.commits.set(sha, body.tree);
      return json(201, { sha });
    }
    if (path === '/repos/acme/web/git/refs') {
      const branch = String(body.ref).replace('refs/heads/', '');
      if (this.refs.has(branch)) return json(422, { message: 'Reference already exists' });
      this.refs.set(branch, body.sha);
      return json(201, {});
    }
    if ((m = /^\/repos\/acme\/web\/git\/refs\/heads\/(.+)$/.exec(path))) {
      this.refs.set(decodeURIComponent(m[1]!), body.sha);
      return json(200, {});
    }
    return json(404, { message: `fake: no route ${method} ${path}` });
  }) as typeof fetch;

  addPull(number: number, patch: Partial<FakePull> = {}): FakePull {
    const pull: FakePull = {
      number,
      title: `PR ${number}`,
      body: null,
      head: { ref: `feature/${number}`, sha: `head-${number}-${randomUUID().slice(0, 8)}` },
      base: { ref: 'main' },
      state: 'open',
      merged: false,
      html_url: `https://github.com/acme/web/pull/${number}`,
      ...patch,
    };
    this.pulls.set(number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------- suite

describe.skipIf(!hasDatabase)('GitHub App integration', () => {
  const label = `gh-${Date.now()}`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config: GithubAppConfig = {
    appId: '1',
    slug: 'specfix-test',
    privateKey,
    clientId: 'c',
    clientSecret: 's',
    webhookSecret: WEBHOOK_SECRET,
  };
  const gh = new FakeGithub();
  const deps: GithubDeps = {
    config,
    fetchImpl: gh.fetch,
    publicBaseUrl: 'https://specfix.example',
  };

  // Ids GitHub would assign; random so reruns against the same database never collide.
  const rand = () => 100_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const installationA = rand();
  const installationB = rand();
  const repoA = rand();
  const repoB = rand();

  let POST: Post;
  let tenantA: string;
  let tenantB: string;
  let projectA: string;
  let projectB: string;
  let repoRowA: string;
  let repoRowB: string;
  const users = {} as Record<'owner' | 'admin' | 'reviewer' | 'ownerB', string>;
  const tickets = {} as Record<'cart1' | 'cart2' | 'bCart1', { id: string; versionId: string }>;
  const scenarios: string[] = [];

  const job = (tenantId: string, payload: Record<string, unknown>): JobRow =>
    ({ id: randomUUID(), tenant_id: tenantId, payload }) as unknown as JobRow;

  async function ticket(tenantId: string, projectId: string, key: string) {
    const t = await ingestTicket(tenantId, projectId, {
      externalId: `${label}-${key}-${tenantId.slice(0, 4)}`,
      externalKey: key,
      title: `<img src=x onerror=alert(1)> ${key} @everyone`,
      descriptionText: 'd',
      acceptanceCriteriaText: '- works',
      raw: null,
      sourceUpdatedAt: null,
    });
    return { id: t.ticket.id, versionId: t.version.id };
  }

  async function scenario(tenantId: string, t: { id: string; versionId: string }, title: string) {
    const [row] = await query<{ id: string }>(
      `insert into scenarios (tenant_id, ticket_id, ticket_version_id, title, gherkin_raw, status, dedupe_key)
       values ($1, $2, $3, $4, 'Scenario: x', 'approved', $4) returning id`,
      [tenantId, t.id, t.versionId, title]
    );
    return row!.id;
  }

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    POST = ((await import(/* @vite-ignore */ ROUTE)) as { POST: Post }).POST;

    tenantA = (await createTenant(label)).id;
    tenantB = (await createTenant(`${label}-b`)).id;
    for (const [name, tenant, role] of [
      ['owner', tenantA, 'owner'],
      ['admin', tenantA, 'admin'],
      ['reviewer', tenantA, 'reviewer'],
      ['ownerB', tenantB, 'owner'],
    ] as const) {
      const [u] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${name}@example.test`]
      );
      users[name] = u!.id;
      await addMembership(tenant, u!.id, role);
    }
    projectA = (await createProject(tenantA, { name: 'Cart', sourceType: 'file' })).id;
    projectB = (await createProject(tenantB, { name: 'Cart B', sourceType: 'file' })).id;
    tickets.cart1 = await ticket(tenantA, projectA, 'CART-1');
    tickets.cart2 = await ticket(tenantA, projectA, 'CART-2');
    tickets.bCart1 = await ticket(tenantB, projectB, 'CART-1');
    await markReady(tenantA, tickets.cart1.id, users.owner);
    for (let i = 0; i < 3; i++) scenarios.push(await scenario(tenantA, tickets.cart1, `s${i}`));
    for (const id of scenarios) {
      const sc = await saveScaffold(tenantA, {
        scenarioId: id,
        ticketId: tickets.cart1.id,
        ticketVersionId: tickets.cart1.versionId,
        framework: 'playwright',
        code: `test('x', { tag: '@sf-${id}' }, async () => {});`,
        selectorPlaceholders: [],
      });
      await decideScaffold(tenantA, { scaffoldId: sc.id, status: 'approved' });
    }

    await saveGithubInstallation(tenantA, users.owner, {
      installationId: installationA,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'selected',
      repos: [{ repoId: repoA, fullName: 'acme/web', defaultBranch: 'main' }],
    });
    await saveGithubInstallation(tenantB, users.ownerB, {
      installationId: installationB,
      accountLogin: 'other',
      accountType: 'Organization',
      repositorySelection: 'selected',
      repos: [{ repoId: repoB, fullName: 'other/web', defaultBranch: 'main' }],
    });
    [{ id: repoRowA }] = (await query<{ id: string }>(
      `select id from github_repositories where repo_id = $1`,
      [repoA]
    )) as [{ id: string }];
    [{ id: repoRowB }] = (await query<{ id: string }>(
      `select id from github_repositories where repo_id = $1`,
      [repoB]
    )) as [{ id: string }];
    await setGithubRepoProject(tenantA, users.owner, repoRowA, projectA);
    await setGithubRepoProject(tenantB, users.ownerB, repoRowB, projectB);
  });

  afterAll(async () => {
    // Queued GitHub jobs must not be picked up by another suite's worker.
    await query(`delete from sync_jobs where tenant_id = any($1::uuid[])`, [[tenantA, tenantB]]);
  });

  // ---------------------------------------------------------------- permissions
  describe('permissions and tenant isolation', () => {
    it('a reviewer cannot connect, map, disconnect or open a scaffold PR', async () => {
      await expect(
        saveGithubInstallation(tenantA, users.reviewer, {
          installationId: rand(),
          accountLogin: 'x',
          accountType: 'User',
          repositorySelection: 'all',
          repos: [],
        })
      ).rejects.toThrow(GithubConnectionError);
      await expect(setGithubRepoProject(tenantA, users.reviewer, repoRowA, null)).rejects.toThrow(
        GithubConnectionError
      );
      await expect(disconnectGithub(tenantA, users.reviewer)).rejects.toThrow(
        GithubConnectionError
      );
      await expect(
        openScaffoldPr(tenantA, users.reviewer, { ticketId: tickets.cart1.id }, deps)
      ).rejects.toThrow(GithubConnectionError);
    });

    it('another workspace cannot claim an installation that is already connected', async () => {
      await expect(
        saveGithubInstallation(tenantB, users.ownerB, {
          installationId: installationA,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'all',
          repos: [{ repoId: repoA, fullName: 'acme/web', defaultBranch: 'main' }],
        })
      ).rejects.toThrow(/another SpecFix workspace/);
      const [row] = await query<{ tenant_id: string }>(
        `select tenant_id from github_installations where installation_id = $1`,
        [installationA]
      );
      expect(row!.tenant_id).toBe(tenantA);
    });

    it('cross-tenant repository and project ids are refused when mapping', async () => {
      await expect(setGithubRepoProject(tenantB, users.ownerB, repoRowA, projectB)).rejects.toThrow(
        /No such/
      );
      await expect(setGithubRepoProject(tenantA, users.owner, repoRowA, projectB)).rejects.toThrow(
        /No such/
      );
      await expect(setGithubRepoProject(tenantA, users.owner, 'not-a-uuid', null)).rejects.toThrow(
        /No such/
      );
    });

    it("a delivery cannot reach another workspace's repository through its own installation", async () => {
      expect(await installationForWebhook(installationA)).toMatchObject({ tenant_id: tenantA });
      expect(await repositoryForWebhook(tenantA, installationA, repoB)).toBeNull();
      expect(await repositoryForWebhook(tenantB, installationA, repoA)).toBeNull();
      expect(await repositoryForWebhook(tenantA, installationA, repoA)).toMatchObject({
        id: repoRowA,
      });
    });

    it("a repository of another workspace's installation is not overwritten by a repo sync", async () => {
      // Tenant B's installation reports tenant A's repository id: A keeps it.
      await saveGithubInstallation(tenantB, users.ownerB, {
        installationId: installationB,
        accountLogin: 'other',
        accountType: 'Organization',
        repositorySelection: 'selected',
        repos: [
          { repoId: repoB, fullName: 'other/web', defaultBranch: 'main' },
          { repoId: repoA, fullName: 'hijack/web', defaultBranch: 'evil' },
        ],
      });
      const [row] = await query<{ tenant_id: string; full_name: string }>(
        `select tenant_id, full_name from github_repositories where repo_id = $1`,
        [repoA]
      );
      expect(row).toEqual({ tenant_id: tenantA, full_name: 'acme/web' });
    });
  });

  // ---------------------------------------------------------------- tokens
  describe('installation token cache', () => {
    it('mints once for 10 concurrent callers and stores only ciphertext', async () => {
      await forgetGithubInstallationToken(tenantA, installationA);
      let minted = 0;
      const mint = async () => {
        minted += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { token: 'ghs_plain_secret_value', expiresAt: new Date(Date.now() + 3600_000) };
      };
      const tokens = await Promise.all(
        Array.from({ length: 10 }, () => getGithubInstallationToken(tenantA, installationA, mint))
      );
      expect(minted).toBe(1);
      expect(new Set(tokens)).toEqual(new Set(['ghs_plain_secret_value']));
      const [row] = await query<{ enc: string }>(
        `select encode(token_enc, 'escape') enc from github_installation_tokens where installation_id = $1`,
        [installationA]
      );
      expect(row!.enc).not.toContain('ghs_plain_secret_value');
    });

    it("refuses another workspace's installation and a suspended one", async () => {
      const mint = async () => ({ token: 't', expiresAt: new Date(Date.now() + 3600_000) });
      await expect(getGithubInstallationToken(tenantB, installationA, mint)).rejects.toThrow(
        GithubConnectionError
      );
      await setGithubInstallationSuspended(tenantA, installationA, true);
      await expect(getGithubInstallationToken(tenantA, installationA, mint)).rejects.toThrow(
        /suspended/
      );
      await setGithubInstallationSuspended(tenantA, installationA, false);
    });

    it('re-mints a token that is about to expire', async () => {
      await forgetGithubInstallationToken(tenantA, installationA);
      let n = 0;
      const mint = async () => ({
        token: `t${++n}`,
        expiresAt: new Date(Date.now() + 60_000), // inside the 5-minute skew
      });
      expect(await getGithubInstallationToken(tenantA, installationA, mint)).toBe('t1');
      expect(await getGithubInstallationToken(tenantA, installationA, mint)).toBe('t2');
      await forgetGithubInstallationToken(tenantA, installationA);
    });
  });

  // ---------------------------------------------------------------- CI placement
  describe('CI run placement (default branch vs PR)', () => {
    const res = (id: string, status: 'passed' | 'failed' = 'passed') => ({
      scenarioId: id,
      status,
      durationMs: 1,
      error: null,
    });

    it('only default-branch runs set the ticket status; a PR merge ref does not', async () => {
      await recordCiRun(tenantA, projectA, {
        commitSha: 'm1',
        branch: 'main',
        runUrl: null,
        unmatched: 0,
        results: [res(scenarios[0]!)],
      });
      const pr = await recordCiRun(tenantA, projectA, {
        commitSha: 'merge-sha',
        branch: '4242/merge',
        runUrl: null,
        unmatched: 0,
        results: [res(scenarios[0]!, 'failed')],
      });
      expect(pr.onDefaultBranch).toBe(false);
      expect(pr.failedTickets).toEqual([]);
      const row = (await latestCiForTicket(tenantA, tickets.cart1.id)).find(
        (r) => r.scenario_id === scenarios[0]
      );
      expect(row).toMatchObject({ status: 'passed', branch: 'main' });
      // The PR is not known yet: it is fetched, which then attaches this run.
      const jobs = await query(
        `select 1 from sync_jobs where tenant_id = $1 and kind = 'github_pr_sync'
           and payload->>'number' = '4242'`,
        [tenantA]
      );
      expect(jobs).toHaveLength(1);
    });

    it("respects the mapped repository's default branch", async () => {
      await query(`update github_repositories set default_branch = 'develop' where id = $1`, [
        repoRowA,
      ]);
      const onMain = await recordCiRun(tenantA, projectA, {
        commitSha: 'x',
        branch: 'main',
        runUrl: null,
        unmatched: 0,
        results: [],
      });
      const onDevelop = await recordCiRun(tenantA, projectA, {
        commitSha: 'y',
        branch: 'develop',
        runUrl: null,
        unmatched: 0,
        results: [],
      });
      expect([onMain.onDefaultBranch, onDevelop.onDefaultBranch]).toEqual([false, true]);
      await query(`update github_repositories set default_branch = 'main' where id = $1`, [
        repoRowA,
      ]);
    });

    it("a run cannot attach to another workspace's repository by naming it", async () => {
      const run = await recordCiRun(tenantB, projectB, {
        commitSha: 'z',
        branch: 'feature',
        runUrl: null,
        unmatched: 0,
        repository: 'acme/web',
        results: [],
      });
      const [row] = await query<{ repository_id: string | null }>(
        `select repository_id from ci_runs where id = $1`,
        [run.runId]
      );
      expect(row!.repository_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------- PR sync
  describe('PR sync: links, warning comment, check run', () => {
    it('links tickets by key in this workspace only, and posts one warning that names keys, not titles', async () => {
      gh.addPull(5, {
        title: 'CART-1: limit quantity',
        body: 'Related: CART-999',
        head: { ref: 'feature/cart-2-quantity', sha: 'head-5a' },
      });
      const out = await runGithubPrSync(job(tenantA, { repositoryId: repoRowA, number: 5 }), deps);
      expect(out).toMatchObject({ linked: 2, notReady: 1 });
      const links = await query<{ ticket_id: string; source: string }>(
        `select l.ticket_id, l.source from github_pr_tickets l
         join github_pull_requests p on p.id = l.pull_request_id
         where p.tenant_id = $1 and p.number = 5 order by l.source`,
        [tenantA]
      );
      expect(links).toEqual([
        { ticket_id: tickets.cart2.id, source: 'branch' },
        { ticket_id: tickets.cart1.id, source: 'title' },
      ]);
      expect(gh.commentsCreated).toBe(1);
      const body = [...gh.comments.values()][0]!;
      expect(body).toContain('CART-2');
      expect(body).not.toMatch(/onerror|@everyone/);
    });

    it('a second sync edits the same comment instead of posting another', async () => {
      await runGithubPrSync(job(tenantA, { repositoryId: repoRowA, number: 5 }), deps);
      expect(gh.commentsCreated).toBe(1);
      expect(
        gh.calls.filter((c) => c.method === 'PATCH' && c.path.includes('/issues/comments/'))
      ).not.toHaveLength(0);
    });

    it('5 concurrent syncs of a new PR still post exactly one comment', async () => {
      gh.addPull(6, { head: { ref: 'CART-2-fix', sha: 'head-6' } });
      const before = gh.commentsCreated;
      await Promise.all(
        Array.from({ length: 5 }, () =>
          runGithubPrSync(job(tenantA, { repositoryId: repoRowA, number: 6 }), deps)
        )
      );
      expect(gh.commentsCreated - before).toBe(1);
      const prs = await query(
        `select 1 from github_pull_requests where tenant_id = $1 and repository_id = $2 and number = 6`,
        [tenantA, repoRowA]
      );
      expect(prs).toHaveLength(1);
    });

    it('a comment deleted on GitHub is posted again while the warning stands', async () => {
      const [pr] = await query<{ warning_comment_id: string }>(
        `select warning_comment_id::text from github_pull_requests where tenant_id = $1 and number = 6`,
        [tenantA]
      );
      gh.comments.delete(Number(pr!.warning_comment_id));
      const before = gh.commentsCreated;
      await runGithubPrSync(job(tenantA, { repositoryId: repoRowA, number: 6 }), deps);
      expect(gh.commentsCreated - before).toBe(1);
    });

    it('a PR that names no ticket gets no comment and no check', async () => {
      gh.addPull(7, { title: 'chore: bump deps', head: { ref: 'deps', sha: 'head-7' } });
      const before = gh.calls.length;
      const out = await runGithubPrSync(job(tenantA, { repositoryId: repoRowA, number: 7 }), deps);
      expect(out).toMatchObject({ linked: 0, check: null });
      expect(gh.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
    });

    it('publishes "SpecFix acceptance" when CI reports on the head commit, then updates it', async () => {
      const run1 = await recordCiRun(tenantA, projectA, {
        commitSha: 'head-5a',
        branch: 'feature/cart-2-quantity',
        runUrl: 'https://ci.example/1',
        unmatched: 0,
        repository: 'acme/web',
        results: [
          { scenarioId: scenarios[0]!, status: 'passed', durationMs: 1, error: null },
          { scenarioId: scenarios[1]!, status: 'passed', durationMs: 1, error: null },
          { scenarioId: scenarios[2]!, status: 'failed', durationMs: 1, error: 'x' },
        ],
      });
      expect(run1.pullRequestId).not.toBeNull();
      expect(run1.onDefaultBranch).toBe(false);
      const queued = await query(
        `select 1 from sync_jobs where tenant_id = $1 and kind = 'github_check_run'
           and payload->>'pullRequestId' = $2`,
        [tenantA, run1.pullRequestId]
      );
      expect(queued.length).toBeGreaterThan(0);

      await runGithubCheckRun(job(tenantA, { pullRequestId: run1.pullRequestId }), deps);
      const created = [...gh.checkRuns.values()].filter((c) => c.head_sha === 'head-5a');
      expect(created).toEqual([
        { head_sha: 'head-5a', conclusion: 'failure', title: '2/3 scenarios passing' },
      ]);

      await recordCiRun(tenantA, projectA, {
        commitSha: 'head-5a',
        branch: 'feature/cart-2-quantity',
        runUrl: null,
        unmatched: 0,
        repository: 'acme/web',
        results: scenarios.map((id) => ({
          scenarioId: id,
          status: 'passed' as const,
          durationMs: 1,
          error: null,
        })),
      });
      await Promise.all(
        Array.from({ length: 5 }, () =>
          runGithubCheckRun(job(tenantA, { pullRequestId: run1.pullRequestId }), deps)
        )
      );
      const after = [...gh.checkRuns.values()].filter((c) => c.head_sha === 'head-5a');
      expect(after).toEqual([
        { head_sha: 'head-5a', conclusion: 'success', title: '3/3 scenarios passing' },
      ]);
      // The PR's runs never touched the ticket's default-branch status.
      const status = await latestCiForTicket(tenantA, tickets.cart1.id);
      expect(status.every((r) => r.branch === 'main')).toBe(true);
    });

    it('marking the ticket ready queues a re-check, which rewrites the warning as resolved', async () => {
      await markReady(tenantA, tickets.cart2.id, users.owner);
      expect(await queueGithubSyncForTicket(tenantA, tickets.cart2.id)).toBeGreaterThan(0);
      await runGithubPrSync(job(tenantA, { repositoryId: repoRowA, number: 5 }), deps);
      const [pr] = await query<{ warning_comment_id: string }>(
        `select warning_comment_id::text from github_pull_requests where tenant_id = $1 and number = 5`,
        [tenantA]
      );
      expect(gh.comments.get(Number(pr!.warning_comment_id))).toContain('now ready');
    });

    it('rejects malformed job payloads as permanent failures', async () => {
      await expect(
        runGithubPrSync(job(tenantA, { repositoryId: "x' or 1=1", number: 1 }), deps)
      ).rejects.toThrow(PermanentJobError);
      await expect(runGithubCheckRun(job(tenantA, { pullRequestId: 42 }), deps)).rejects.toThrow(
        PermanentJobError
      );
    });

    it("a job naming another workspace's repository does nothing", async () => {
      const out = await runGithubPrSync(job(tenantB, { repositoryId: repoRowA, number: 5 }), deps);
      expect(out).toEqual({ skipped: 'repository no longer connected' });
    });
  });

  // ---------------------------------------------------------------- scaffold PR
  describe('Open PR with scaffolds', () => {
    it('5 concurrent clicks make one branch, one commit and one PR', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          openScaffoldPr(tenantA, users.admin, { ticketId: tickets.cart1.id }, deps)
        )
      );
      expect(gh.pullsCreated).toBe(1);
      expect(new Set(results.map((r) => r.number)).size).toBe(1);
      expect(results.filter((r) => !r.reused)).toHaveLength(1);
      expect(gh.refs.get('specfix/CART-1')).toMatch(/^commit-/);
      const files = [...gh.trees.values()].flat().map((f) => f.path);
      expect(files).toEqual(scenarios.map((id) => `tests/specfix/CART-1/${id}.spec.ts`));
      const [link] = await query<{ source: string }>(
        `select l.source from github_pr_tickets l join github_pull_requests p on p.id = l.pull_request_id
         where l.tenant_id = $1 and l.ticket_id = $2 and p.number = $3`,
        [tenantA, tickets.cart1.id, results[0]!.number]
      );
      expect(link!.source).toBe('specfix');
    });

    it('a later click reuses the open PR without calling GitHub', async () => {
      const before = gh.calls.length;
      const again = await openScaffoldPr(
        tenantA,
        users.owner,
        { ticketId: tickets.cart1.id },
        deps
      );
      expect(again.reused).toBe(true);
      expect(gh.calls.length).toBe(before);
    });

    it('refuses without approved scaffolds, and with a repository of another workspace', async () => {
      await expect(
        openScaffoldPr(tenantA, users.owner, { ticketId: tickets.cart2.id }, deps)
      ).rejects.toThrow(/Approve at least one scaffold/);
      await expect(
        openScaffoldPr(
          tenantA,
          users.owner,
          { ticketId: tickets.cart1.id, repositoryId: repoRowB },
          deps
        )
      ).rejects.toThrow(/Choose which repository/);
      await expect(
        openScaffoldPr(tenantB, users.ownerB, { ticketId: tickets.cart1.id }, deps)
      ).rejects.toThrow(/Ticket not found/);
    });
  });

  // ---------------------------------------------------------------- webhook route
  describe('POST /api/github/webhook (route handler called directly)', () => {
    const prBody = (number: number, repoId = repoA, installationId = installationA) =>
      JSON.stringify({
        action: 'synchronize',
        number,
        installation: { id: installationId },
        repository: { id: repoId },
        pull_request: { number, title: 'ignored: the worker re-reads the PR' },
      });
    const send = (
      body: string | ReadableStream<Uint8Array>,
      headers: Record<string, string> = {}
    ) =>
      POST(
        new Request('http://localhost/api/github/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'pull_request',
            'x-github-delivery': randomUUID(),
            ...(typeof body === 'string'
              ? { 'x-hub-signature-256': signGithubBody(body, WEBHOOK_SECRET) }
              : {}),
            ...headers,
          },
          body,
          ...(typeof body === 'string' ? {} : { duplex: 'half' }),
        } as RequestInit)
      );
    const pendingFor = async (number: number) =>
      (
        await query(
          `select 1 from sync_jobs where tenant_id = $1 and kind = 'github_pr_sync'
             and status = 'queued' and payload->>'number' = $2`,
          [tenantA, String(number)]
        )
      ).length;

    it('queues a PR re-read for a signed delivery, with an empty body', async () => {
      const r = await send(prBody(301));
      expect(r.status).toBe(202);
      expect(await r.text()).toBe('');
      expect(await pendingFor(301)).toBe(1);
    });

    it.each([
      ['no signature', { 'x-hub-signature-256': '' }],
      ['a forged signature', { 'x-hub-signature-256': signGithubBody('{}', WEBHOOK_SECRET) }],
      ['the wrong secret', { 'x-hub-signature-256': signGithubBody(prBody(302), 'guess') }],
    ])('401s %s and queues nothing', async (_n, headers) => {
      const r = await send(prBody(302), headers);
      expect(r.status).toBe(401);
      expect(await r.text()).toBe('');
      expect(await pendingFor(302)).toBe(0);
    });

    it('drops a redelivery of the same X-GitHub-Delivery', async () => {
      const id = randomUUID();
      expect((await send(prBody(303), { 'x-github-delivery': id })).status).toBe(202);
      expect((await send(prBody(303), { 'x-github-delivery': id })).status).toBe(204);
      expect(await pendingFor(303)).toBe(1);
    });

    it('a replay under a fresh delivery id cannot multiply work (job dedupe)', async () => {
      for (let i = 0; i < 5; i++) expect((await send(prBody(304))).status).toBe(202);
      expect(await pendingFor(304)).toBe(1);
    });

    it('400s a malformed delivery id or a signed non-JSON body', async () => {
      expect((await send(prBody(305), { 'x-github-delivery': "1'; drop table x" })).status).toBe(
        400
      );
      expect((await send('not json')).status).toBe(400);
    });

    it("ignores a delivery naming another workspace's repository, or an unknown installation", async () => {
      expect((await send(prBody(306, repoB))).status).toBe(204);
      expect((await send(prBody(306, repoA, rand()))).status).toBe(204);
      expect(await pendingFor(306)).toBe(0);
      const recorded = await query(`select 1 from sync_jobs where payload->>'number' = '306'`);
      expect(recorded).toHaveLength(0);
    });

    it('handles suspend / unsuspend and queues a repo sync on installation_repositories', async () => {
      const install = (action: string, event = 'installation') =>
        send(JSON.stringify({ action, installation: { id: installationA } }), {
          'x-github-event': event,
        });
      expect((await install('suspend')).status).toBe(202);
      expect((await installationForWebhook(installationA))?.suspended).toBe(true);
      expect((await send(prBody(307))).status).toBe(204);
      expect((await install('unsuspend')).status).toBe(202);
      expect((await installationForWebhook(installationA))?.suspended).toBe(false);
      expect((await install('added', 'installation_repositories')).status).toBe(202);
      const jobs = await query(
        `select 1 from sync_jobs where tenant_id = $1 and kind = 'github_repo_sync'`,
        [tenantA]
      );
      expect(jobs.length).toBeGreaterThan(0);
    });

    it('answers ping with 204', async () => {
      expect((await send('{"zen":"x"}', { 'x-github-event': 'ping' })).status).toBe(204);
    });

    it('a burst of 200 deliveries for 5 PRs leaves exactly one pending re-read per PR', async () => {
      const statuses = await Promise.all(
        Array.from({ length: 200 }, (_, i) => send(prBody(400 + (i % 5))).then((r) => r.status))
      );
      expect(statuses.filter((s) => s !== 202)).toEqual([]);
      for (let n = 400; n < 405; n++) expect(await pendingFor(n)).toBe(1);
    });

    it('50 concurrent copies of one delivery are accepted exactly once', async () => {
      const id = randomUUID();
      const statuses = await Promise.all(
        Array.from({ length: 50 }, () =>
          send(prBody(410), { 'x-github-delivery': id }).then((r) => r.status)
        )
      );
      expect(statuses.filter((s) => s === 202)).toHaveLength(1);
      expect(statuses.filter((s) => s === 204)).toHaveLength(49);
    });

    it('413s an oversized body, declared or chunked, and queues nothing', async () => {
      const big = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
      expect((await send(big)).status).toBe(413);
      const chunk = new TextEncoder().encode('x'.repeat(300_000));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent++ >= 5) return c.close();
          c.enqueue(chunk);
        },
      });
      expect(
        (await send(stream, { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` })).status
      ).toBe(413);
    });

    it('503s when the server has no webhook secret', async () => {
      const saved = process.env.GITHUB_WEBHOOK_SECRET;
      delete process.env.GITHUB_WEBHOOK_SECRET;
      try {
        expect((await send(prBody(308))).status).toBe(503);
      } finally {
        process.env.GITHUB_WEBHOOK_SECRET = saved;
      }
    });

    it('installation deleted forgets the installation and everything under it', async () => {
      const r = await send(
        JSON.stringify({ action: 'deleted', installation: { id: installationB } }),
        { 'x-github-event': 'installation' }
      );
      expect(r.status).toBe(202);
      expect(await installationForWebhook(installationB)).toBeNull();
      const repos = await query(`select 1 from github_repositories where repo_id = $1`, [repoB]);
      expect(repos).toHaveLength(0);
    });
  });
});
