/**
 * Sign-off ("mark ready for development") waits for an analysis of the exact text being signed
 * off: no flags because the model never ran is not the same as no flags left.
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ReadinessError,
  addMembership,
  closePool,
  createProject,
  createTenant,
  ingestTicket,
  markReady,
  query,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('mark ready needs an analysis', () => {
  const label = `ready${Date.now()}`;
  let tenant: string;
  let project: string;
  let owner: string;

  const ticket = (text: string) =>
    ingestTicket(tenant, project, {
      externalId: `${label}-1`,
      externalKey: 'RDY-1',
      title: 'Ready check',
      descriptionText: text,
      acceptanceCriteriaText: '- works',
      raw: null,
      sourceUpdatedAt: null,
    });

  const run = (t: Awaited<ReturnType<typeof ticket>>, status: 'succeeded' | 'failed') =>
    query(
      `insert into analysis_runs
         (tenant_id, ticket_id, ticket_version_id, prompt_version, model, temperature, status)
       values ($1, $2, $3, 'test', 'test-model', 1, $4)`,
      [tenant, t.ticket.id, t.version.id, status]
    );

  beforeAll(async () => {
    tenant = (await createTenant(label)).id;
    const [u] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}@example.test`]
    );
    owner = u!.id;
    await addMembership(tenant, owner, 'owner');
    project = (await createProject(tenant, { name: 'Ready', sourceType: 'file' })).id;
  });

  it('refuses a version that was never analyzed, or only failed', async () => {
    const t = await ticket('v1');
    await expect(markReady(tenant, t.ticket.id, owner)).rejects.toThrow(/not been analyzed/);
    await run(t, 'failed');
    await expect(markReady(tenant, t.ticket.id, owner)).rejects.toBeInstanceOf(ReadinessError);
  });

  it('allows it once the current version has a succeeded analysis and no open flag', async () => {
    const t = await ticket('v1');
    await run(t, 'succeeded');
    expect((await markReady(tenant, t.ticket.id, owner)).event).toBe('marked_ready');
  });

  it('refuses again after the text changes, until the new version is analyzed', async () => {
    const t = await ticket('v2 edited');
    expect(t.isNewVersion).toBe(true);
    await expect(markReady(tenant, t.ticket.id, owner)).rejects.toThrow(/not been analyzed/);
  });
});
