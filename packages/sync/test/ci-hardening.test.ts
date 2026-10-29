/**
 * Phase 3 hardening: CI tokens, recordCiRun, tenant/project isolation, notifications,
 * and the /api/ci/results route handler called directly (no Next server).
 *
 * The route imports `@/lib/repos` (an app path alias that re-exports @specfix/db behind
 * 'server-only'); it is mocked to @specfix/db here. The route is imported by a computed
 * path so the root typecheck does not follow it into the app's alias space.
 *
 * Tests named `fixed: …` were found failing by the hardening pass and fixed; they stay
 * as regression tests for those defects.
 *
 * Needs SPECFIX_TEST_DATABASE_URL (a disposable database); skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  CiTokenError,
  addMembership,
  closePool,
  createCiToken,
  createProject,
  createTenant,
  ingestTicket,
  latestCiForTicket,
  latestCiRuns,
  listCiTokens,
  listNotifications,
  query,
  recordCiRun,
  resolveCiToken,
  revokeCiToken,
  type CiResultInput,
} from '@specfix/db';

vi.mock('@/lib/repos', async () => await import('@specfix/db'));
// The app's real body reader, loaded by path; 'server-only' is a build-time guard.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/read-limited', async () => await import('../../../apps/web/lib/read-limited.ts'));

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

type Post = (request: Request) => Promise<Response>;
const ROUTE = fileURLToPath(
  new URL('../../../apps/web/app/api/ci/results/route.ts', import.meta.url)
);
async function loadPost(): Promise<Post> {
  const mod = (await import(/* @vite-ignore */ ROUTE)) as { POST: Post };
  return mod.POST;
}

const UNKNOWN = '99999999-9999-4999-8999-999999999999';

describe.skipIf(!hasDatabase)('CI hardening', () => {
  const label = `cih-${Date.now()}`;
  let POST: Post;
  let tenantId: string;
  let otherTenantId: string;
  let projectId: string;
  let otherProjectId: string;
  let foreignTenantProjectId: string;
  let ticketId: string;
  let ticket2Id: string;
  let foreignTicketId: string;
  let sA: string; // approved, ticket 1
  let sB: string; // approved, ticket 1
  let sDismissed: string; // dismissed, ticket 1
  let sT2: string; // approved, ticket 2
  let sOtherProject: string;
  let sOtherTenant: string;
  const users = {} as Record<'owner' | 'admin' | 'reviewer' | 'outsider' | 'otherOwner', string>;

  async function user(role: string): Promise<string> {
    const [u] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-${role}@example.test`]
    );
    return u!.id;
  }

  async function scenario(
    tenant: string,
    ticket: string,
    versionId: string,
    title: string,
    status = 'approved'
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `insert into scenarios (tenant_id, ticket_id, ticket_version_id, title, gherkin_raw, status,
                              dedupe_key)
       values ($1, $2, $3, $4, 'Scenario: x', $5, $4) returning id`,
      [tenant, ticket, versionId, title, status]
    );
    return row!.id;
  }

  const ticket = (tenant: string, project: string, id: string) =>
    ingestTicket(tenant, project, {
      externalId: id,
      externalKey: id,
      title: id,
      descriptionText: '',
      acceptanceCriteriaText: '',
      raw: null,
      sourceUpdatedAt: null,
    });

  const res = (
    scenarioId: string,
    status: CiResultInput['status'] = 'passed',
    extra: Partial<CiResultInput> = {}
  ): CiResultInput => ({ scenarioId, status, durationMs: 5, error: null, ...extra });

  const baseRun = { commitSha: 'abc', branch: 'main', runUrl: null, unmatched: 0 };

  const report = (entries: Array<[string, string, Record<string, unknown>?]>) => ({
    suites: [
      {
        specs: entries.map(([id, status, result]) => ({
          title: 't',
          tags: [`sf-${id}`],
          tests: [{ status, results: [{ duration: 3, ...(result ?? {}) }] }],
        })),
      },
    ],
  });

  const post = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    POST(
      new Request('http://localhost/api/ci/results', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        // Needed by undici for a stream body.
        ...(typeof body === 'string' ? {} : { duplex: 'half' }),
      } as RequestInit)
    );

  beforeAll(async () => {
    POST = await loadPost();
    tenantId = (await createTenant(label)).id;
    otherTenantId = (await createTenant(`${label}-other`)).id;
    for (const role of ['owner', 'admin', 'reviewer'] as const) {
      users[role] = await user(role);
      await addMembership(tenantId, users[role], role);
    }
    users.outsider = await user('outsider');
    users.otherOwner = await user('otherOwner');
    await addMembership(otherTenantId, users.otherOwner, 'owner');

    projectId = (await createProject(tenantId, { name: 'Cart', sourceType: 'file' })).id;
    otherProjectId = (await createProject(tenantId, { name: 'Other', sourceType: 'file' })).id;
    foreignTenantProjectId = (
      await createProject(otherTenantId, { name: 'Foreign', sourceType: 'file' })
    ).id;

    const t1 = await ticket(tenantId, projectId, 'CART-1');
    ticketId = t1.ticket.id;
    sA = await scenario(tenantId, ticketId, t1.version.id, 'a');
    sB = await scenario(tenantId, ticketId, t1.version.id, 'b');
    sDismissed = await scenario(tenantId, ticketId, t1.version.id, 'gone', 'dismissed');
    const t2 = await ticket(tenantId, projectId, 'CART-2');
    ticket2Id = t2.ticket.id;
    sT2 = await scenario(tenantId, ticket2Id, t2.version.id, 'c');
    const t3 = await ticket(tenantId, otherProjectId, 'OTHER-1');
    sOtherProject = await scenario(tenantId, t3.ticket.id, t3.version.id, 'elsewhere');
    const t4 = await ticket(otherTenantId, foreignTenantProjectId, 'FOREIGN-1');
    foreignTicketId = t4.ticket.id;
    sOtherTenant = await scenario(otherTenantId, foreignTicketId, t4.version.id, 'foreign');
  });

  // ---------------------------------------------------------------- tokens
  describe('tokens', () => {
    it('token format: sfci_ + 43 base64url chars (256 bits), prefix is 12 chars', async () => {
      const token = await createCiToken(tenantId, users.owner, projectId);
      expect(token).toMatch(/^sfci_[A-Za-z0-9_-]{43}$/);
      const [row] = await listCiTokens(tenantId);
      expect(row!.token_prefix).toBe(token.slice(0, 12));
    });

    it('admin may create; reviewer and non-member may not (CiTokenError)', async () => {
      await expect(createCiToken(tenantId, users.admin, projectId)).resolves.toMatch(/^sfci_/);
      await expect(createCiToken(tenantId, users.reviewer, projectId)).rejects.toBeInstanceOf(
        CiTokenError
      );
      await expect(createCiToken(tenantId, users.outsider, projectId)).rejects.toBeInstanceOf(
        CiTokenError
      );
      await expect(revokeCiToken(tenantId, users.reviewer, projectId)).rejects.toBeInstanceOf(
        CiTokenError
      );
    });

    it("an owner of another tenant cannot mint a token for this tenant's project", async () => {
      await expect(createCiToken(tenantId, users.otherOwner, projectId)).rejects.toBeInstanceOf(
        CiTokenError
      );
      // …nor through their own tenant id with our project id.
      await expect(createCiToken(otherTenantId, users.otherOwner, projectId)).rejects.toThrow(
        'No such project.'
      );
    });

    it('fixed: a non-uuid project id surfaces a raw Postgres error, not CiTokenError', async () => {
      await expect(createCiToken(tenantId, users.owner, 'not-a-uuid')).rejects.toBeInstanceOf(
        CiTokenError
      );
    });

    it.each([
      ['empty', ''],
      ['prefix only', 'sfci_'],
      ['19 chars', `sfci_${'a'.repeat(19)}`],
      ['wrong prefix', `sfcx_${'a'.repeat(43)}`],
      ['trailing newline', `sfci_${'a'.repeat(43)}\n`],
      ['SQL meta chars', `sfci_' or '1'='1`],
      ['unicode', `sfci_${'é'.repeat(43)}`],
      ['well-formed but unknown', `sfci_${'a'.repeat(43)}`],
      ['very long', `sfci_${'a'.repeat(100_000)}`],
    ])('resolveCiToken(%s) → null', async (_n, token) => {
      expect(await resolveCiToken(token)).toBeNull();
    });

    it('token comparison is case-sensitive and exact', async () => {
      const token = await createCiToken(tenantId, users.owner, projectId);
      expect(await resolveCiToken(token)).not.toBeNull();
      const flipped = token.slice(0, 5) + token.slice(5).replace(/[a-z]/, (c) => c.toUpperCase());
      if (flipped !== token) expect(await resolveCiToken(flipped)).toBeNull();
      expect(await resolveCiToken(token.slice(0, -1))).toBeNull();
      expect(await resolveCiToken(`${token}x`)).toBeNull();
    });

    it('last_used_at is set only once a run is stored, not by a lookup', async () => {
      const token = await createCiToken(tenantId, users.owner, projectId);
      const usedAt = async () =>
        (await listCiTokens(tenantId)).find((r) => r.project_id === projectId)!.last_used_at;
      expect(await usedAt()).toBeNull();
      const scope = await resolveCiToken(token);
      expect(await usedAt()).toBeNull();
      await recordCiRun(tenantId, projectId, {
        commitSha: null,
        branch: null,
        runUrl: null,
        unmatched: 0,
        results: [],
        tokenHash: scope!.token_hash,
      });
      expect(await usedAt()).toBeInstanceOf(Date);
    });

    it('revoked and replaced tokens stop resolving; revoke is idempotent', async () => {
      const t1 = await createCiToken(tenantId, users.owner, projectId);
      const t2 = await createCiToken(tenantId, users.owner, projectId);
      expect(await resolveCiToken(t1)).toBeNull();
      await revokeCiToken(tenantId, users.owner, projectId);
      await revokeCiToken(tenantId, users.owner, projectId);
      expect(await resolveCiToken(t2)).toBeNull();
      expect((await listCiTokens(tenantId)).some((r) => r.project_id === projectId)).toBe(false);
    });

    it('revoking project A leaves project B and other tenants alone', async () => {
      const a = await createCiToken(tenantId, users.owner, projectId);
      const b = await createCiToken(tenantId, users.owner, otherProjectId);
      const f = await createCiToken(otherTenantId, users.otherOwner, foreignTenantProjectId);
      await revokeCiToken(tenantId, users.owner, projectId);
      expect(await resolveCiToken(a)).toBeNull();
      expect(await resolveCiToken(b)).toMatchObject({
        tenant_id: tenantId,
        project_id: otherProjectId,
      });
      expect(await resolveCiToken(f)).toMatchObject({
        tenant_id: otherTenantId,
        project_id: foreignTenantProjectId,
      });
      // Revoking with our tenant id cannot touch the foreign project's token.
      await revokeCiToken(tenantId, users.owner, foreignTenantProjectId);
      expect(await resolveCiToken(f)).not.toBeNull();
    });

    it('concurrent createCiToken: at most one live token per project', async () => {
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () => createCiToken(tenantId, users.owner, projectId))
      );
      const live = await query<{ n: number }>(
        `select count(*)::int as n from ci_tokens
         where tenant_id = $1 and project_id = $2 and revoked_at is null`,
        [tenantId, projectId]
      );
      expect(live[0]!.n).toBe(1);
      const ok = settled.filter(
        (s) => s.status === 'fulfilled'
      ) as PromiseFulfilledResult<string>[];
      const resolved = await Promise.all(ok.map((s) => resolveCiToken(s.value)));
      expect(resolved.filter(Boolean)).toHaveLength(1);
    });

    it('fixed: concurrent createCiToken surfaces a raw unique-violation instead of succeeding', async () => {
      for (let round = 0; round < 5; round++) {
        const settled = await Promise.allSettled(
          Array.from({ length: 6 }, () => createCiToken(tenantId, users.owner, projectId))
        );
        for (const s of settled) {
          if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(CiTokenError);
        }
      }
    });
  });

  // ---------------------------------------------------------------- recordCiRun
  describe('recordCiRun', () => {
    it('drops scenarios of another project, another tenant, and unknown ids; counts them', async () => {
      const r = await recordCiRun(tenantId, projectId, {
        ...baseRun,
        unmatched: 3,
        results: [res(sA), res(sOtherProject), res(sOtherTenant, 'failed'), res(UNKNOWN, 'failed')],
      });
      expect(r).toMatchObject({ matched: 1, unmatched: 6, failedTickets: [] });
      const leaked = await query(`select 1 from ci_results where scenario_id = any($1::uuid[])`, [
        [sOtherProject, sOtherTenant],
      ]);
      expect(leaked).toHaveLength(0);
    });

    it('a token from the other tenant cannot write onto our scenarios (route-level scope)', async () => {
      const r = await recordCiRun(otherTenantId, foreignTenantProjectId, {
        ...baseRun,
        results: [res(sA, 'failed'), res(sB, 'failed')],
      });
      expect(r.matched).toBe(0);
      expect(r.failedTickets).toEqual([]);
    });

    it('empty results still create a run with zero counts', async () => {
      const r = await recordCiRun(tenantId, projectId, { ...baseRun, results: [] });
      const [run] = await query<{ total: number; unmatched: number }>(
        `select total, unmatched from ci_runs where id = $1`,
        [r.runId]
      );
      expect(run).toEqual({ total: 0, unmatched: 0 });
    });

    it('counts statuses and failed tickets per ticket', async () => {
      const r = await recordCiRun(tenantId, projectId, {
        ...baseRun,
        results: [res(sA, 'failed'), res(sB, 'flaky'), res(sT2, 'skipped')],
      });
      const [run] = await query(
        `select total, passed, failed, flaky, skipped from ci_runs where id = $1`,
        [r.runId]
      );
      expect(run).toEqual({ total: 3, passed: 0, failed: 1, flaky: 1, skipped: 1 });
      expect(r.failedTickets).toEqual([{ ticket_id: ticketId, failed: 1, total: 2 }]);
    });

    it.each([
      ['javascript:', 'javascript:alert(1)', null],
      ['http:', 'http://ci.example.com/run/1', null],
      ['data:', 'data:text/html,<script>alert(1)</script>', null],
      // URL schemes are case-insensitive; the stored link is normalised.
      ['uppercase HTTPS', 'HTTPS://ci.example.com', 'https://ci.example.com/'],
      ['protocol-relative', '//evil.example', null],
      ['https', 'https://github.com/a/b/actions/runs/1', 'https://github.com/a/b/actions/runs/1'],
      ['https to any host (accepted)', 'https://evil.example/phish', 'https://evil.example/phish'],
    ])('run_url %s → stored %s', async (_n, url, stored) => {
      const r = await recordCiRun(tenantId, projectId, { ...baseRun, runUrl: url, results: [] });
      const [row] = await query<{ run_url: string | null }>(
        `select run_url from ci_runs where id = $1`,
        [r.runId]
      );
      expect(row!.run_url).toBe(stored);
    });

    it('very long commit/branch/run_url are truncated to 64/200/500', async () => {
      const r = await recordCiRun(tenantId, projectId, {
        commitSha: 'c'.repeat(10_000),
        branch: 'b'.repeat(10_000),
        runUrl: `https://x/${'u'.repeat(10_000)}`,
        unmatched: 0,
        results: [],
      });
      const [row] = await query<{ c: number; b: number; u: number }>(
        `select length(commit_sha) c, length(branch) b, length(run_url) u from ci_runs where id = $1`,
        [r.runId]
      );
      expect(row).toEqual({ c: 64, b: 200, u: 500 });
    });

    it('SQL-looking strings are stored verbatim (parameterised)', async () => {
      const evil = `main'; drop table ci_runs; --`;
      const r = await recordCiRun(tenantId, projectId, {
        ...baseRun,
        branch: evil,
        results: [res(sA, 'failed', { error: `'); delete from ci_results; --` })],
      });
      const [row] = await query<{ branch: string }>(`select branch from ci_runs where id = $1`, [
        r.runId,
      ]);
      expect(row!.branch).toBe(evil);
    });

    it('negative durations are clamped to 0; fractional ones rounded', async () => {
      const r = await recordCiRun(tenantId, projectId, {
        ...baseRun,
        results: [res(sA, 'passed', { durationMs: -50 }), res(sB, 'passed', { durationMs: 2.6 })],
      });
      const rows = await query<{ scenario_id: string; duration_ms: number }>(
        `select scenario_id, duration_ms from ci_results where ci_run_id = $1`,
        [r.runId]
      );
      expect(Object.fromEntries(rows.map((x) => [x.scenario_id, x.duration_ms]))).toEqual({
        [sA]: 0,
        [sB]: 3,
      });
    });

    it('a lone surrogate in the error text is stored (driver replaces it)', async () => {
      await expect(
        recordCiRun(tenantId, projectId, {
          ...baseRun,
          results: [res(sA, 'failed', { error: 'x\ud83d' })],
        })
      ).resolves.toMatchObject({ matched: 1 });
    });

    it('fixed: a NUL byte in an error message makes the whole run fail (22021)', async () => {
      await expect(
        recordCiRun(tenantId, projectId, {
          ...baseRun,
          results: [res(sA, 'failed', { error: 'bad\u0000byte' })],
        })
      ).resolves.toMatchObject({ matched: 1 });
    });

    it('fixed: a NUL byte in the branch makes the whole run fail (22021)', async () => {
      await expect(
        recordCiRun(tenantId, projectId, { ...baseRun, branch: 'ma\u0000in', results: [] })
      ).resolves.toBeDefined();
    });

    it('fixed: a duration over 2^31 ms makes the whole run fail (integer out of range)', async () => {
      await expect(
        recordCiRun(tenantId, projectId, {
          ...baseRun,
          results: [res(sA, 'passed', { durationMs: 3e9 })],
        })
      ).resolves.toBeDefined();
    });

    it('fixed: an Infinity duration makes the whole run fail', async () => {
      await expect(
        recordCiRun(tenantId, projectId, {
          ...baseRun,
          results: [res(sA, 'passed', { durationMs: Number.POSITIVE_INFINITY })],
        })
      ).resolves.toBeDefined();
    });

    it('duplicate scenario ids in one call throw (PK) — parser dedupes, direct callers must', async () => {
      await expect(
        recordCiRun(tenantId, projectId, { ...baseRun, results: [res(sA), res(sA, 'failed')] })
      ).rejects.toThrow(/duplicate key/);
    });

    it('nothing is written when the run fails mid-way (transaction rolls back)', async () => {
      const before = await query<{ n: number }>(
        `select count(*)::int n from ci_runs where tenant_id = $1`,
        [tenantId]
      );
      await recordCiRun(tenantId, projectId, {
        ...baseRun,
        results: [res(sA), res(sA)],
      }).catch(() => undefined);
      const after = await query<{ n: number }>(
        `select count(*)::int n from ci_runs where tenant_id = $1`,
        [tenantId]
      );
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('fixed: a failure of a dismissed scenario is counted in failedTickets (notifies)', async () => {
      const r = await recordCiRun(tenantId, projectId, {
        ...baseRun,
        results: [res(sA), res(sDismissed, 'failed')],
      });
      expect(r.failedTickets).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- reads
  describe('latestCiForTicket / latestCiRuns', () => {
    it('newest result per scenario wins; older runs ignored', async () => {
      await recordCiRun(tenantId, projectId, {
        ...baseRun,
        commitSha: 'old',
        results: [res(sT2, 'failed')],
      });
      await recordCiRun(tenantId, projectId, { ...baseRun, commitSha: 'new', results: [res(sT2)] });
      const rows = await latestCiForTicket(tenantId, ticket2Id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scenario_id: sT2, status: 'passed', commit_sha: 'new' });
    });

    it('a scenario missing from the newest run keeps its older result (not "not reported")', async () => {
      await recordCiRun(tenantId, projectId, {
        ...baseRun,
        commitSha: 'only-a',
        results: [res(sA)],
      });
      const rows = await latestCiForTicket(tenantId, ticketId);
      const b = rows.find((r) => r.scenario_id === sB);
      expect(b).toBeDefined();
      expect(b!.commit_sha).not.toBe('only-a');
    });

    it('cross-tenant: reading our ticket with another tenant id returns nothing', async () => {
      expect(await latestCiForTicket(otherTenantId, ticketId)).toEqual([]);
      expect(await latestCiForTicket(tenantId, foreignTicketId)).toEqual([]);
    });

    it('latestCiRuns is tenant-scoped and one row per project', async () => {
      await recordCiRun(otherTenantId, foreignTenantProjectId, { ...baseRun, results: [] });
      const ours = await latestCiRuns(tenantId);
      expect(ours.every((r) => [projectId, otherProjectId].includes(r.project_id))).toBe(true);
      expect(new Set(ours.map((r) => r.project_id)).size).toBe(ours.length);
      const theirs = await latestCiRuns(otherTenantId);
      expect(theirs.map((r) => r.project_id)).toEqual([foreignTenantProjectId]);
    });

    it('fixed: a feature-branch run no longer overrides main in latestCiForTicket', async () => {
      await recordCiRun(tenantId, projectId, { ...baseRun, branch: 'main', results: [res(sT2)] });
      await recordCiRun(tenantId, projectId, {
        ...baseRun,
        branch: 'wip/experiment',
        results: [res(sT2, 'failed')],
      });
      const [row] = await latestCiForTicket(tenantId, ticket2Id);
      expect(row).toMatchObject({ branch: 'main', status: 'passed' });
    });
  });

  // ---------------------------------------------------------------- route
  describe('POST /api/ci/results (route handler called directly)', () => {
    let token: string;
    beforeAll(async () => {
      token = await createCiToken(tenantId, users.owner, projectId);
    });
    const auth = () => ({ authorization: `Bearer ${token}` });

    it.each([
      ['no header', {}],
      ['Basic scheme', { authorization: 'Basic abc' }],
      ['Bearer, no token', { authorization: 'Bearer ' }],
      ['unknown token', { authorization: `Bearer sfci_${'a'.repeat(43)}` }],
      ['two tokens', { authorization: `Bearer sfci_${'a'.repeat(43)} sfci_${'b'.repeat(43)}` }],
    ])('401 for %s, same message for every case', async (_n, headers) => {
      const r = await post('{"suites":[]}', headers as Record<string, string>);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'Unknown or revoked CI token.' });
    });

    it('lowercase "bearer" and extra spaces are accepted', async () => {
      const r = await post('{"suites":[]}', { authorization: `bearer    ${token}` });
      expect(r.status).toBe(201);
    });

    it('auth is checked before the body is read (401 even for a garbage body)', async () => {
      const r = await post('not json', { authorization: 'Bearer nope' });
      expect(r.status).toBe(401);
    });

    it('a revoked token gets 401', async () => {
      const old = await createCiToken(tenantId, users.owner, otherProjectId);
      await revokeCiToken(tenantId, users.owner, otherProjectId);
      expect((await post('{"suites":[]}', { authorization: `Bearer ${old}` })).status).toBe(401);
    });

    it('400 for non-JSON', async () => {
      const r = await post('{', auth());
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'Body is not JSON.' });
    });

    it.each([
      ['[]', '[]'],
      ['a number', '5'],
      ['a string', '"x"'],
      ['report: string', '{"report":"{\\"suites\\":[]}"}'],
      ['report without suites', '{"report":{}}'],
    ])('400 for %s', async (_n, body) => {
      expect((await post(body, auth())).status).toBe(400);
    });

    it('a JSON `null` body is a 400 with a fixed message, no internal error text', async () => {
      const r = await post('null', auth());
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'Not a Playwright JSON report.' });
    });

    it('malformed report members are ignored rather than failing the run', async () => {
      const r = await post('{"suites":[null]}', auth());
      expect(r.status).toBe(201);
      expect(await r.json()).toMatchObject({ matched: 0, unmatched: 0 });
    });

    it('accepts a wrapped report and a raw report; 201 with counts', async () => {
      const wrapped = await post(
        JSON.stringify({ commit: ' abc ', branch: 'main', report: report([[sA, 'expected']]) }),
        auth()
      );
      expect(wrapped.status).toBe(201);
      expect(await wrapped.json()).toMatchObject({ matched: 1, unmatched: 0 });
      const raw = await post(
        JSON.stringify(
          report([
            [sA, 'expected'],
            [UNKNOWN, 'expected'],
          ])
        ),
        auth()
      );
      expect(await raw.json()).toMatchObject({ matched: 1, unmatched: 1 });
    });

    it('report wins over top-level suites when both are present', async () => {
      const r = await post(
        JSON.stringify({ report: report([[sA, 'expected']]), suites: [] }),
        auth()
      );
      expect(await r.json()).toMatchObject({ matched: 1 });
    });

    it('non-string commit/branch/runUrl are ignored; whitespace trimmed', async () => {
      const r = await post(
        JSON.stringify({ commit: 123, branch: { x: 1 }, runUrl: ['https://x'], suites: [] }),
        auth()
      );
      const { run } = (await r.json()) as { run: string };
      const [row] = await query(`select commit_sha, branch, run_url from ci_runs where id = $1`, [
        run,
      ]);
      expect(row).toEqual({ commit_sha: null, branch: null, run_url: null });
    });

    it("scenario ids of another project / tenant posted with this project's token are ignored", async () => {
      const r = await post(
        JSON.stringify(
          report([
            [sOtherProject, 'unexpected'],
            [sOtherTenant, 'unexpected'],
          ])
        ),
        auth()
      );
      expect(await r.json()).toMatchObject({ matched: 0, unmatched: 2 });
    });

    it('413 when Content-Length claims more than 5 MB (before reading)', async () => {
      const r = await post('{"suites":[]}', { ...auth(), 'content-length': '5000001' });
      expect(r.status).toBe(413);
    });

    it('413 for a >5M-char body with a lying Content-Length (read fully, then rejected)', async () => {
      const big = `{"suites":[],"pad":"${'x'.repeat(5_000_000)}"}`;
      const enc = new TextEncoder().encode(big);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc);
          c.close();
        },
      });
      const r = await post(stream, { ...auth(), 'content-length': '10' });
      expect(r.status).toBe(413);
    });

    it('fixed: the 5 MB limit counts UTF-16 units, so ~14 MB of 3-byte chars is accepted', async () => {
      const big = `{"suites":[],"pad":"${'€'.repeat(4_900_000)}"}`;
      expect(new TextEncoder().encode(big).length).toBeGreaterThan(14_000_000);
      const r = await post(big, auth());
      expect(r.status).toBe(413);
    });

    it('fixed: an error message containing \\u0000 makes the route throw (500)', async () => {
      const body = JSON.stringify(
        report([[sA, 'unexpected', { error: { message: 'binary \u0000 diff' } }]])
      );
      expect((await post(body, auth())).status).toBe(201);
    });

    it('fixed: a duration of 1e400 (JSON → Infinity) makes the route throw (500)', async () => {
      const body = `{"suites":[{"specs":[{"tags":["sf-${sA}"],"tests":[{"status":"expected","results":[{"duration":1e400}]}]}]}]}`;
      expect((await post(body, auth())).status).toBe(201);
    });

    it('a failing ticket notifies owner and admin, not the reviewer', async () => {
      const before = await Promise.all(
        (['owner', 'admin', 'reviewer'] as const).map(
          async (u) =>
            (await listNotifications(tenantId, users[u])).filter((n) => n.kind === 'ci_failed')
              .length
        )
      );
      const r = await post(
        JSON.stringify({
          commit: 'deadbeefcafebabe0123',
          report: report([
            [sA, 'unexpected', { error: { message: '<b>x</b>' } }],
            [sB, 'expected'],
          ]),
        }),
        auth()
      );
      expect(r.status).toBe(201);
      const after = await Promise.all(
        (['owner', 'admin', 'reviewer'] as const).map(
          async (u) =>
            (await listNotifications(tenantId, users[u])).filter((n) => n.kind === 'ci_failed')
              .length
        )
      );
      expect(after.map((n, i) => n - before[i]!)).toEqual([1, 1, 0]);
      const [latest] = (await listNotifications(tenantId, users.owner)).filter(
        (n) => n.kind === 'ci_failed'
      );
      expect(latest!.payload).toMatchObject({
        failed: 1,
        total: 2,
        commit: 'deadbeefcafe',
        key: 'CART-1',
      });
      // No other tenant's members are notified.
      expect(
        (await listNotifications(otherTenantId, users.otherOwner)).filter(
          (n) => n.kind === 'ci_failed'
        )
      ).toHaveLength(0);
    });

    it('a scenario that keeps failing notifies once, not on every run', async () => {
      const count = async () =>
        (await listNotifications(tenantId, users.owner, 1000)).filter((n) => n.kind === 'ci_failed')
          .length;
      // Start from a passing result so the next failure is a new one.
      await post(JSON.stringify(report([[sA, 'expected']])), auth());
      const before = await count();
      const body = JSON.stringify(report([[sA, 'unexpected']]));
      for (let i = 0; i < 3; i++) await post(body, auth());
      expect((await count()) - before).toBe(1);
      // Fixed, then broken again: that is news, so it notifies again.
      await post(JSON.stringify(report([[sA, 'expected']])), auth());
      await post(body, auth());
      expect((await count()) - before).toBe(2);
    });

    it('a passing run creates no notification', async () => {
      const count = async () => (await listNotifications(tenantId, users.owner, 1000)).length;
      const before = await count();
      await post(
        JSON.stringify(
          report([
            [sA, 'expected'],
            [sB, 'flaky'],
          ])
        ),
        auth()
      );
      expect(await count()).toBe(before);
    });
  });
});
