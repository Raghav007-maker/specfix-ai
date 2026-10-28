/**
 * Jira backfill, the analysis budget guards, and the job queue, against a real
 * Postgres and a stubbed Jira. No model is called: analysis is a stub.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AnalyzeOutcome } from '@specfix/core';
import {
  addJiraProject,
  addMembership,
  claimJob,
  closePool,
  countAnalysisCandidates,
  createTenant,
  enqueueJob,
  getSyncProject,
  latestProjectJobs,
  query,
  requestAnalysisBatch,
  requestJiraBackfill,
  saveJiraGrant,
  setJiraSite,
  type JobRow,
} from '@specfix/db';
import { JiraClient, type JiraIssue } from '@specfix/ingest';
import {
  PermanentJobError,
  runAnalyzeBatch,
  runBackfill,
  runNextJob,
  type AnalyzeBatchDeps,
  type BackfillDeps,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function issue(
  n: number,
  opts: { type?: string; status?: string; updated?: string; body?: string } = {}
): JiraIssue {
  return {
    id: String(10_000 + n),
    key: `CART-${n}`,
    fields: {
      summary: `Story ${n}`,
      updated: opts.updated ?? daysAgo(1),
      issuetype: { name: opts.type ?? 'Story' },
      status: { name: 'To Do', statusCategory: { key: opts.status ?? 'new' } },
      reporter: { accountId: 'acc-pm' },
      assignee: { accountId: 'acc-dev' },
      description: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: opts.body ?? `Body ${n}` }] },
        ],
      },
    },
  };
}

/** A Jira that serves `pages` in order for /search/jql and records each request body. */
function fakeJira(pages: JiraIssue[][]) {
  const bodies: Array<{ nextPageToken?: string }> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    const index = body.nextPageToken ? Number(String(body.nextPageToken).slice(1)) : 0;
    const issues = pages[index] ?? [];
    const next = index + 1 < pages.length ? `p${index + 1}` : undefined;
    return new Response(JSON.stringify({ issues, nextPageToken: next, isLast: !next }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const client = new JiraClient({
    cloudId: 'cloud-a',
    getAccessToken: async () => 't',
    fetch: fetchImpl,
  });
  return { client, bodies };
}

function backfillDeps(pages: JiraIssue[][], cloudId = 'cloud-a') {
  const jira = fakeJira(pages);
  const embedded: string[][] = [];
  const deps: BackfillDeps = {
    clientFor: async () => ({ client: jira.client, cloudId }),
    embed: async (_t, ids) => void embedded.push(ids),
  };
  return { deps, bodies: jira.bodies, embedded };
}

function outcome(costUsd = 0.0003): AnalyzeOutcome {
  return {
    flags: [],
    calls: [],
    renderedTicketBody: '',
    meta: {
      promptVersion: 'single-shot-v1@test',
      model: 'gpt-5.4-mini',
      temperature: 1,
      seed: null,
      truncated: false,
      attempts: 1,
      inputTokens: 1000,
      outputTokens: 100,
      costUsd,
      latencyMs: 1,
      duplicatesDropped: 0,
      unverifiedSpans: 0,
    },
  };
}

describe.skipIf(!hasDatabase)('jira backfill and analysis', () => {
  const label = `sync-${Date.now()}`;
  let tenantId: string;
  let projectId: string;
  const users = {} as Record<'admin' | 'reviewer', string>;

  async function backfillJob(): Promise<JobRow> {
    const job = await requestJiraBackfill(tenantId, users.admin, projectId);
    if (!job) throw new Error('backfill not queued');
    return job;
  }

  async function finishAll() {
    await query(`update sync_jobs set status = 'done' where status in ('queued', 'running')`);
  }

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    process.env.OPENAI_API_KEY ||= 'sk-test-not-used';
    tenantId = (await createTenant(label)).id;
    for (const role of ['admin', 'reviewer'] as const) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${role}@example.test`]
      );
      users[role] = user!.id;
      await addMembership(tenantId, user!.id, role);
    }
    await saveJiraGrant(tenantId, users.admin, 'read', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['read:jira-work'],
    });
    await setJiraSite(tenantId, users.admin, {
      cloudId: 'cloud-a',
      siteUrl: 'https://acme.atlassian.net',
      siteName: 'Acme',
    });
    projectId = (await addJiraProject(tenantId, users.admin, { projectKey: 'CART', name: 'Cart' }))
      .id;
  });

  beforeEach(finishAll);

  it('only an admin can queue an import, and a second request while one is pending is a no-op', async () => {
    await expect(requestJiraBackfill(tenantId, users.reviewer, projectId)).rejects.toThrow();
    const first = await requestJiraBackfill(tenantId, users.admin, projectId);
    expect(first).not.toBeNull();
    expect(await requestJiraBackfill(tenantId, users.admin, projectId)).toBeNull();
  });

  it('imports every page, keeps Jira facts, embeds new versions, and never analyzes', async () => {
    const { deps, embedded } = backfillDeps([
      [issue(1), issue(2, { type: 'Epic' })],
      [issue(3, { status: 'done' }), issue(4, { updated: daysAgo(60) })],
    ]);
    const progress = await runBackfill(await backfillJob(), deps);
    expect(progress).toMatchObject({ seen: 4, newVersions: 4, unchanged: 0, pages: 2 });
    expect(embedded.flat()).toHaveLength(4);

    const [row] = await query<{
      issue_type: string;
      status_category: string;
      reporter_account_id: string;
    }>(
      `select issue_type, status_category, reporter_account_id from tickets
       where tenant_id = $1 and external_key = 'CART-3'`,
      [tenantId]
    );
    expect(row).toEqual({
      issue_type: 'Story',
      status_category: 'done',
      reporter_account_id: 'acc-pm',
    });
    const runs = await query(`select 1 from analysis_runs where tenant_id = $1`, [tenantId]);
    expect(runs).toHaveLength(0);
    expect((await getSyncProject(tenantId, projectId))?.last_synced_at).not.toBeNull();
  });

  it('is idempotent: importing again creates no versions', async () => {
    const { deps, embedded } = backfillDeps([
      [issue(1), issue(2, { type: 'Epic' })],
      [issue(3, { status: 'done' }), issue(4, { updated: daysAgo(60) })],
    ]);
    const progress = await runBackfill(await backfillJob(), deps);
    expect(progress).toMatchObject({ newVersions: 0, unchanged: 4 });
    expect(embedded).toHaveLength(0);
  });

  it('resumes from the checkpointed page token', async () => {
    const { deps, bodies } = backfillDeps([[issue(1)], [issue(5)]]);
    const job = await backfillJob();
    await runBackfill({ ...job, payload: { nextPageToken: 'p1' } }, deps);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.nextPageToken).toBe('p1');
  });

  it('refuses to import from a different site than the project belongs to', async () => {
    const { deps } = backfillDeps([[issue(1)]], 'cloud-other');
    await expect(runBackfill(await backfillJob(), deps)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('picks only open, requirement-shaped, recently updated tickets for analysis', async () => {
    // CART-1 and CART-5 qualify. CART-2 is an Epic, CART-3 is done, CART-4 is 60 days old.
    expect(await countAnalysisCandidates(tenantId, projectId)).toBe(2);
  });

  describe('analysis batches', () => {
    function deps(overrides: Partial<AnalyzeBatchDeps> = {}) {
      const analyzed: string[] = [];
      const d: AnalyzeBatchDeps = {
        analyze: async (ticket) => {
          analyzed.push(ticket.externalKey);
          return outcome();
        },
        overCap: async () => false,
        modelPriced: () => true,
        maxUsd: 1,
        notify: async () => {},
        ...overrides,
      };
      return { deps: d, analyzed };
    }

    async function batch(limit = 50) {
      const queued = await requestAnalysisBatch(tenantId, users.admin, projectId, limit);
      if (!queued) throw new Error('batch not queued');
      return queued;
    }

    it('only an admin can start one, and it is capped at the requested size', async () => {
      await expect(requestAnalysisBatch(tenantId, users.reviewer, projectId, 50)).rejects.toThrow();
      const { count, job } = await batch(1);
      expect(count).toBe(1);
      expect(job.payload.versionIds).toHaveLength(1);
      expect(job.max_attempts).toBe(1);
      expect(await requestAnalysisBatch(tenantId, users.admin, projectId, 50)).toBeNull();
    });

    it('stops before calling the model when the workspace is over its token cap', async () => {
      const { job } = await batch();
      const { deps: d, analyzed } = deps({ overCap: async () => true });
      const progress = await runAnalyzeBatch(job, d);
      expect(progress.stopped).toBe('token_cap');
      expect(analyzed).toEqual([]);
    });

    it('refuses a model with no known price', async () => {
      const { job } = await batch();
      await expect(
        runAnalyzeBatch(job, deps({ modelPriced: () => false }).deps)
      ).rejects.toBeInstanceOf(PermanentJobError);
    });

    it('stops once the batch reaches its spending limit', async () => {
      const { job } = await batch();
      const { deps: d, analyzed } = deps({
        analyze: async (t) => {
          analyzed.push(t.externalKey);
          return outcome(0.6);
        },
        maxUsd: 0.5,
      });
      const progress = await runAnalyzeBatch(job, d);
      expect(analyzed).toHaveLength(1);
      expect(progress).toMatchObject({ analyzed: 1, stopped: 'batch_budget' });
    });

    it('never pays twice for a version, and a finished ticket stops qualifying', async () => {
      const { job } = await batch();
      const first = deps();
      await runAnalyzeBatch(job, first.deps);
      // CART-5 was analyzed by the budget test; only CART-1 was left.
      expect(first.analyzed).toEqual(['CART-1']);
      expect(await countAnalysisCandidates(tenantId, projectId)).toBe(0);

      const again = deps();
      const progress = await runAnalyzeBatch(job, again.deps);
      expect(again.analyzed).toEqual([]);
      expect(progress.skipped).toBe(1);
    });

    it('records failures, and leaves a version that keeps failing out of later batches', async () => {
      // An edit makes CART-1 a new, unanalyzed version.
      await runBackfill(
        await backfillJob(),
        backfillDeps([[issue(1, { body: 'Edited body' })]]).deps
      );
      await finishAll();
      expect(await countAnalysisCandidates(tenantId, projectId)).toBe(1);

      const failing = deps({
        analyze: async () => {
          throw new Error('model returned junk');
        },
      });
      for (let i = 0; i < 2; i++) {
        const { job } = await batch();
        const progress = await runAnalyzeBatch(job, failing.deps);
        expect(progress.failed).toBe(1);
        await finishAll();
      }
      const failed = await query(
        `select 1 from analysis_runs where tenant_id = $1 and status = 'failed'`,
        [tenantId]
      );
      expect(failed).toHaveLength(2);
      expect(await countAnalysisCandidates(tenantId, projectId)).toBe(0);
    });
  });

  describe('job queue', () => {
    it('completes, retries, and fails jobs by the kind of error', async () => {
      const handlers = {
        jira_backfill: async () => ({ ok: true }),
        analyze_batch: async () => {
          throw new PermanentJobError('no');
        },
      };
      const quiet = () => {};

      await enqueueJob(tenantId, { kind: 'jira_backfill', projectId });
      const done = await runNextJob(handlers, quiet);
      expect(done?.kind).toBe('jira_backfill');

      await enqueueJob(tenantId, { kind: 'analyze_batch', projectId });
      await runNextJob(handlers, quiet);

      const flaky = {
        ...handlers,
        jira_backfill: async () => Promise.reject(new Error('ECONNRESET')),
      };
      await enqueueJob(tenantId, { kind: 'jira_backfill', projectId, maxAttempts: 3 });
      await runNextJob(flaky, quiet);

      const jobs = await latestProjectJobs(tenantId);
      const backfill = jobs.find((j) => j.kind === 'jira_backfill')!;
      const analysis = jobs.find((j) => j.kind === 'analyze_batch')!;
      expect(analysis).toMatchObject({ status: 'failed', last_error: 'no' });
      expect(backfill).toMatchObject({ status: 'queued', attempts: 1, last_error: 'ECONNRESET' });
      // Backoff: not claimable again right away.
      expect(await claimJob()).toBeNull();
    });

    it('fails, rather than re-runs, a lapsed job that used its last attempt', async () => {
      const job = await enqueueJob(tenantId, { kind: 'analyze_batch', projectId, maxAttempts: 1 });
      await query(
        `update sync_jobs set status = 'running', attempts = 1, locked_until = now() - interval '1 minute'
         where id = $1`,
        [job!.id]
      );
      expect(await claimJob()).toBeNull();
      const [row] = await query<{ status: string }>(`select status from sync_jobs where id = $1`, [
        job!.id,
      ]);
      expect(row!.status).toBe('failed');
    });

    it('reclaims a lapsed job that still has attempts left', async () => {
      const job = await enqueueJob(tenantId, { kind: 'jira_backfill', projectId, maxAttempts: 3 });
      await query(
        `update sync_jobs set status = 'running', attempts = 1, locked_until = now() - interval '1 minute'
         where id = $1`,
        [job!.id]
      );
      const claimed = await claimJob();
      expect(claimed?.id).toBe(job!.id);
      expect(claimed?.attempts).toBe(2);
    });
  });
});
