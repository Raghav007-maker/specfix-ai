/**
 * What the spec queue shows an admin about failed analyses: the latest error, how many tries,
 * whether the ticket has left the queue, and nothing once a run succeeds or from another tenant.
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_FAILED_ANALYSES,
  closePool,
  createProject,
  createTenant,
  ingestTicket,
  query,
  recentAnalysisFailures,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('recent analysis failures', () => {
  const label = `fail${Date.now()}`;
  let tenant: string;
  let other: string;
  let project: string;

  const ticket = (key: string) =>
    ingestTicket(tenant, project, {
      externalId: `${label}-${key}`,
      externalKey: key,
      title: key,
      descriptionText: 'd',
      acceptanceCriteriaText: '- a',
      raw: null,
      sourceUpdatedAt: null,
    });

  const run = (
    t: Awaited<ReturnType<typeof ticket>>,
    status: 'succeeded' | 'failed',
    error: string | null = null
  ) =>
    query(
      `insert into analysis_runs
         (tenant_id, ticket_id, ticket_version_id, prompt_version, model, temperature, status, error)
       values ($1, $2, $3, 'test', 'test-model', 1, $4, $5)`,
      [tenant, t.ticket.id, t.version.id, status, error]
    );

  beforeAll(async () => {
    tenant = (await createTenant(label)).id;
    other = (await createTenant(`${label}-other`)).id;
    project = (await createProject(tenant, { name: 'Fail', sourceType: 'file' })).id;
  });

  it('lists a failing ticket with its latest error, and marks it given up after the limit', async () => {
    const t = await ticket('FAIL-1');
    await run(t, 'failed', 'first error');
    let [row] = await recentAnalysisFailures(tenant, project);
    expect(row).toMatchObject({ external_key: 'FAIL-1', failures: 1, given_up: false });
    for (let i = 1; i < MAX_FAILED_ANALYSES; i++) await run(t, 'failed', 'OpenAI: invalid API key');
    [row] = await recentAnalysisFailures(tenant, project);
    expect(row).toMatchObject({ failures: MAX_FAILED_ANALYSES, given_up: true });
    expect(row!.error).toBe('OpenAI: invalid API key');
  });

  it('drops a ticket once its version succeeds, and shows nothing to another tenant', async () => {
    const t = await ticket('FAIL-2');
    await run(t, 'failed', 'timeout');
    await run(t, 'succeeded');
    const keys = (await recentAnalysisFailures(tenant, project)).map((r) => r.external_key);
    expect(keys).not.toContain('FAIL-2');
    expect(await recentAnalysisFailures(other, project)).toEqual([]);
  });
});
