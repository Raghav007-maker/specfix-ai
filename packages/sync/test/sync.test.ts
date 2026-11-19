/**
 * Spec tickets sent from portal tasks, the analysis budget guards, and the job queue,
 * against a real Postgres. No model is called: analysis is a stub.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyzeOutcome } from '@specfix/core';
import {
  addMembership,
  claimJob,
  closePool,
  countAnalysisCandidates,
  createProject,
  createTenant,
  createWorkItem,
  enqueueJob,
  latestProjectJobs,
  query,
  requestAnalysisBatch,
  sendTaskForSpecReview,
  updateWorkItem,
} from '@specfix/db';
import {
  PermanentJobError,
  runAnalyzeBatch,
  runNextJob,
  type AnalyzeBatchDeps,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

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

describe.skipIf(!hasDatabase)('spec tickets from tasks, and analysis', () => {
  const label = `sync-${Date.now()}`;
  let tenantId: string;
  let projectId: string;
  const users = {} as Record<'owner' | 'admin' | 'reviewer', string>;
  const task = {} as Record<'story' | 'epic' | 'done' | 'plain', { id: string; key: string }>;

  async function finishAll() {
    await query(`update sync_jobs set status = 'done' where status in ('queued', 'running')`);
  }

  async function newTask(fields: Record<string, string>) {
    const created = await createWorkItem(tenantId, users.owner, projectId, fields);
    return { id: created.id, key: created.key };
  }

  beforeAll(async () => {
    process.env.OPENAI_API_KEY ||= 'sk-test-not-used';
    tenantId = (await createTenant(label)).id;
    for (const role of ['owner', 'admin', 'reviewer'] as const) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${role}@example.test`]
      );
      users[role] = user!.id;
      await addMembership(tenantId, user!.id, role);
    }
    projectId = (await createProject(tenantId, { name: 'Cart', sourceType: 'file' })).id;
    task.story = await newTask({
      title: 'Coupon at checkout',
      type: 'story',
      description: 'A shopper applies a coupon.',
      acceptanceCriteria: 'Given a cart over 500, when the coupon applies, the total drops 10%.',
    });
    task.plain = await newTask({ title: 'Saved addresses', type: 'task' });
    task.epic = await newTask({ title: 'Payments platform', type: 'epic' });
    task.done = await newTask({ title: 'Old checkout', type: 'task', status: 'done' });
  });

  beforeEach(finishAll);

  it('turns a task into a spec ticket keyed like the task, and links them', async () => {
    const sent = await sendTaskForSpecReview(tenantId, users.owner, task.story.id);
    expect(sent).toMatchObject({ key: task.story.key, isNewVersion: true });
    const [row] = await query<{ external_key: string; acceptance_criteria_text: string }>(
      `select external_key, acceptance_criteria_text from tickets where tenant_id = $1 and id = $2`,
      [tenantId, sent.ticketId]
    );
    expect(row).toEqual({
      external_key: task.story.key,
      acceptance_criteria_text:
        'Given a cart over 500, when the coupon applies, the total drops 10%.',
    });
    const [linked] = await query<{ ticket_id: string }>(
      `select ticket_id from work_items where tenant_id = $1 and id = $2`,
      [tenantId, task.story.id]
    );
    expect(linked!.ticket_id).toBe(sent.ticketId);
  });

  it('sending again without a text change makes no new version', async () => {
    const again = await sendTaskForSpecReview(tenantId, users.owner, task.story.id);
    expect(again.isNewVersion).toBe(false);
  });

  it('refuses an epic, a task in another tenant, and a forged id', async () => {
    await expect(sendTaskForSpecReview(tenantId, users.owner, task.epic.id)).rejects.toThrow(
      /not reviewed on its own/
    );
    const other = (await createTenant(`${label}-other`)).id;
    await expect(sendTaskForSpecReview(other, users.owner, task.story.id)).rejects.toThrow();
    await expect(sendTaskForSpecReview(tenantId, users.owner, "x' or 1=1 --")).rejects.toThrow();
  });

  it('refuses someone who is not in the project', async () => {
    // A workspace reviewer sees only the projects they were added to.
    await expect(sendTaskForSpecReview(tenantId, users.reviewer, task.plain.id)).rejects.toThrow();
  });

  it('picks only open, requirement-shaped tickets for analysis', async () => {
    await sendTaskForSpecReview(tenantId, users.owner, task.plain.id);
    await sendTaskForSpecReview(tenantId, users.owner, task.done.id);
    // The story and the plain task qualify; the finished task does not.
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
      // The budget test analyzed the newer ticket; only the story was left.
      expect(first.analyzed).toEqual([task.story.key]);
      expect(await countAnalysisCandidates(tenantId, projectId)).toBe(0);

      const again = deps();
      const progress = await runAnalyzeBatch(job, again.deps);
      expect(again.analyzed).toEqual([]);
      expect(progress.skipped).toBe(1);
    });

    it('records failures, and leaves a version that keeps failing out of later batches', async () => {
      // An edit makes the story a new, unanalyzed version.
      await updateWorkItem(tenantId, users.owner, task.story.id, {
        title: 'Coupon at checkout',
        type: 'story',
        description: 'Edited body',
        acceptanceCriteria: 'Given a cart over 500, when the coupon applies, the total drops 10%.',
      });
      expect((await sendTaskForSpecReview(tenantId, users.owner, task.story.id)).isNewVersion).toBe(
        true
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
        notify_deliver: async () => ({ ok: true }),
        analyze_batch: async () => {
          throw new PermanentJobError('no');
        },
      };
      const quiet = () => {};

      await enqueueJob(tenantId, { kind: 'notify_deliver', projectId });
      const done = await runNextJob(handlers, quiet);
      expect(done?.kind).toBe('notify_deliver');

      await enqueueJob(tenantId, { kind: 'analyze_batch', projectId });
      await runNextJob(handlers, quiet);

      const flaky = {
        ...handlers,
        notify_deliver: async () => Promise.reject(new Error('ECONNRESET')),
      };
      await enqueueJob(tenantId, { kind: 'notify_deliver', projectId, maxAttempts: 3 });
      await runNextJob(flaky, quiet);

      const jobs = await latestProjectJobs(tenantId);
      const delivery = jobs.find((j) => j.kind === 'notify_deliver')!;
      const analysis = jobs.find((j) => j.kind === 'analyze_batch')!;
      expect(analysis).toMatchObject({ status: 'failed', last_error: 'no' });
      expect(delivery).toMatchObject({ status: 'queued', attempts: 1, last_error: 'ECONNRESET' });
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
      const job = await enqueueJob(tenantId, { kind: 'notify_deliver', projectId, maxAttempts: 3 });
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
