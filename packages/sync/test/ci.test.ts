/**
 * Phase 3: Playwright report parsing, CI tokens, and recording results against the
 * right scenarios. The DB suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CiTokenError,
  addMembership,
  closePool,
  createCiToken,
  createProject,
  createTenant,
  ingestTicket,
  latestCiForTicket,
  listCiTokens,
  query,
  recordCiRun,
  resolveCiToken,
  revokeCiToken,
} from '@specfix/db';
import { parsePlaywrightReport } from '@specfix/ingest';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function report(
  specs: Array<{
    title: string;
    tags?: string[];
    status: string;
    error?: string;
    duration?: number;
  }>
) {
  return {
    config: {},
    suites: [
      {
        title: 'cart.spec.ts',
        suites: [
          {
            title: 'CART-1',
            specs: specs.map((s) => ({
              title: s.title,
              tags: s.tags ?? [],
              tests: [
                {
                  status: s.status,
                  results: [
                    {
                      status: s.status === 'unexpected' ? 'failed' : 'passed',
                      duration: s.duration ?? 10,
                      ...(s.error ? { error: { message: s.error } } : {}),
                    },
                  ],
                },
              ],
            })),
          },
        ],
      },
    ],
  };
}

describe('parsePlaywrightReport', () => {
  it('maps tagged tests to scenarios and counts the rest as unmatched', () => {
    const parsed = parsePlaywrightReport(
      report([
        { title: 'adds 99 items', tags: [`@sf-${A}`], status: 'expected' },
        {
          title: `rejects 100 @sf-${B}`,
          status: 'unexpected',
          error: '\u001b[31mExpected 422\u001b[39m, got 500\nat line 3',
        },
        { title: 'some other test', status: 'expected' },
      ])
    );
    expect(parsed.unmatched).toBe(1);
    expect(parsed.results).toEqual([
      { scenarioId: A, status: 'passed', durationMs: 10, error: null },
      {
        scenarioId: B,
        status: 'failed',
        durationMs: 10,
        error: 'Expected 422, got 500\nat line 3',
      },
    ]);
  });

  it('treats fixme/skipped as skipped and keeps the worst outcome across browsers', () => {
    const parsed = parsePlaywrightReport(
      report([
        { title: 'x', tags: [`sf-${A}`], status: 'skipped' },
        { title: 'x', tags: [`@sf-${A}`], status: 'flaky' },
      ])
    );
    expect(parsed.results).toEqual([
      { scenarioId: A, status: 'flaky', durationMs: 20, error: null },
    ]);
  });

  it('rejects something that is not a Playwright report', () => {
    expect(() => parsePlaywrightReport({ tests: [] })).toThrow(/Playwright JSON report/);
  });
});

describe.skipIf(!hasDatabase)('CI results', () => {
  const label = `ci-${Date.now()}`;
  let tenantId: string;
  let projectId: string;
  let otherProjectId: string;
  let ticketId: string;
  let scenarioA: string;
  let scenarioB: string;
  let foreignScenario: string;
  const users = {} as Record<'owner' | 'reviewer', string>;

  async function scenario(ticket: string, versionId: string, title: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `insert into scenarios (tenant_id, ticket_id, ticket_version_id, title, gherkin_raw, status,
                              dedupe_key)
       values ($1, $2, $3, $4, 'Scenario: x', 'approved', $4) returning id`,
      [tenantId, ticket, versionId, title]
    );
    return row!.id;
  }

  beforeAll(async () => {
    tenantId = (await createTenant(label)).id;
    for (const role of ['owner', 'reviewer'] as const) {
      const [u] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${role}@example.test`]
      );
      users[role] = u!.id;
      await addMembership(tenantId, u!.id, role);
    }
    projectId = (await createProject(tenantId, { name: 'Cart', sourceType: 'file' })).id;
    otherProjectId = (await createProject(tenantId, { name: 'Other', sourceType: 'file' })).id;
    const ticket = (id: string, project: string) =>
      ingestTicket(tenantId, project, {
        externalId: id,
        externalKey: id,
        title: id,
        descriptionText: '',
        acceptanceCriteriaText: '',
        raw: null,
        sourceUpdatedAt: null,
      });
    const t1 = await ticket('CART-1', projectId);
    ticketId = t1.ticket.id;
    scenarioA = await scenario(ticketId, t1.version.id, 'adds 99 items');
    scenarioB = await scenario(ticketId, t1.version.id, 'rejects 100');
    const t2 = await ticket('OTHER-1', otherProjectId);
    foreignScenario = await scenario(t2.ticket.id, t2.version.id, 'elsewhere');
  });

  it('only owners and admins create tokens; one live token per project; revocation works', async () => {
    await expect(createCiToken(tenantId, users.reviewer, projectId)).rejects.toBeInstanceOf(
      CiTokenError
    );
    const first = await createCiToken(tenantId, users.owner, projectId);
    const second = await createCiToken(tenantId, users.owner, projectId);
    expect(second).toMatch(/^sfci_/);
    expect(await resolveCiToken(first)).toBeNull();
    expect(await resolveCiToken(second)).toMatchObject({
      tenant_id: tenantId,
      project_id: projectId,
    });
    expect(await listCiTokens(tenantId)).toHaveLength(1);

    const stored = await query<{ token_hash: string }>(
      `select token_hash from ci_tokens where tenant_id = $1`,
      [tenantId]
    );
    expect(stored.every((r) => !r.token_hash.includes(second))).toBe(true);

    await revokeCiToken(tenantId, users.owner, projectId);
    expect(await resolveCiToken(second)).toBeNull();
    expect(await resolveCiToken('not-a-token')).toBeNull();
  });

  it("records results only for the token project's scenarios", async () => {
    const recorded = await recordCiRun(tenantId, projectId, {
      commitSha: 'abc1234def',
      branch: 'main',
      runUrl: 'javascript:alert(1)',
      unmatched: 1,
      results: [
        { scenarioId: scenarioA, status: 'passed', durationMs: 5, error: null },
        { scenarioId: scenarioB, status: 'failed', durationMs: 7, error: 'Expected 422, got 500' },
        { scenarioId: foreignScenario, status: 'passed', durationMs: 1, error: null },
      ],
    });
    expect(recorded.matched).toBe(2);
    expect(recorded.unmatched).toBe(2);
    expect(recorded.failedTickets).toEqual([{ ticket_id: ticketId, failed: 1, total: 2 }]);

    const rows = await latestCiForTicket(tenantId, ticketId);
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'passed']);
    expect(rows[0]!.run_url).toBeNull();
    const foreign = await query(`select 1 from ci_results where scenario_id = $1`, [
      foreignScenario,
    ]);
    expect(foreign).toHaveLength(0);
  });

  it('shows the newest result per scenario', async () => {
    await recordCiRun(tenantId, projectId, {
      commitSha: 'fff0000',
      branch: 'main',
      runUrl: 'https://github.com/acme/app/actions/runs/1',
      unmatched: 0,
      results: [{ scenarioId: scenarioB, status: 'passed', durationMs: 3, error: null }],
    });
    const b = (await latestCiForTicket(tenantId, ticketId)).find(
      (r) => r.scenario_id === scenarioB
    )!;
    expect(b).toMatchObject({ status: 'passed', commit_sha: 'fff0000' });
  });
});
