/**
 * Load on the job queue: several workers draining hundreds of jobs at once must claim
 * each job exactly once, and recurring scheduling under concurrency must not duplicate.
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJob,
  closePool,
  completeJob,
  createTenant,
  enqueueJob,
  query,
  type JobRow,
} from '@specfix/db';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('job queue under load', () => {
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (await createTenant(`load-${Date.now()}`)).id;
    // Only this suite's jobs may be claimed.
    await query(`update sync_jobs set status = 'done' where status in ('queued', 'running')`);
  });

  it('8 concurrent workers drain 500 jobs, each claimed exactly once', async () => {
    for (let i = 0; i < 500; i++) {
      await enqueueJob(tenantId, { kind: 'notify_deliver', payload: { n: i } });
    }
    const claimedBy = new Map<string, number>();
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 8 }, async (_, worker) => {
        for (;;) {
          const job: JobRow | null = await claimJob();
          if (!job) return;
          claimedBy.set(job.id, (claimedBy.get(job.id) ?? 0) + 1);
          await completeJob(job.tenant_id, job.id);
          void worker;
        }
      })
    );
    console.log(`[load] queue: 500 jobs by 8 workers in ${Date.now() - started}ms`);
    expect(claimedBy.size).toBe(500);
    expect([...claimedBy.values()].every((n) => n === 1)).toBe(true);
    const left = await query(`select 1 from sync_jobs where tenant_id = $1 and status <> 'done'`, [
      tenantId,
    ]);
    expect(left).toHaveLength(0);
  }, 120_000);

  it('200 concurrent enqueues with one dedupe key leave exactly one pending job', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        enqueueJob(tenantId, { kind: 'jira_reconcile', dedupeKey: `reconcile:${tenantId}` })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const pending = await query(
      `select 1 from sync_jobs where tenant_id = $1 and kind = 'jira_reconcile' and status = 'queued'`,
      [tenantId]
    );
    expect(pending).toHaveLength(1);
  }, 60_000);
});
