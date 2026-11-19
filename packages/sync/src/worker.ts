/**
 * The worker loop: claim a job, run its handler, record the outcome.
 *
 * Which failures are retried: a PermanentJobError is not (the job fails at once and says
 * why), nor a job of a kind this worker no longer runs; anything else — a network blip, a 429 that outlasted
 * the client's own retries, a 5xx — goes back on the queue with backoff until the job's
 * max_attempts is used up. Analysis batches have max_attempts 1, so a failed batch is
 * never re-run without an admin asking again.
 */
import {
  claimJob,
  completeJob,
  enqueueJob,
  dueDigestRecipients,
  failJob,
  pendingEmailTenants,
  pruneGithubDeliveries,
  type JobKind,
  type JobRow,
} from '@specfix/db';
import { runAnalyzeBatch } from './analyze-batch.ts';
import { PermanentJobError } from './errors.ts';
import { runGithubCheckRun, runGithubPrSync, runGithubRepoSync } from './github.ts';
import { runNotifyDeliver, runNotifyDigest } from './notify.ts';

export type JobHandler = (job: JobRow) => Promise<object>;

export const defaultHandlers: Record<JobKind, JobHandler> = {
  analyze_batch: (job) => runAnalyzeBatch(job),
  notify_deliver: (job) => runNotifyDeliver(job),
  notify_digest: (job) => runNotifyDigest(job),
  github_pr_sync: (job) => runGithubPrSync(job),
  github_check_run: (job) => runGithubCheckRun(job),
  github_repo_sync: (job) => runGithubRepoSync(job),
};

/**
 * Queues the recurring work that has come due: email delivery and the daily digest. Dedupe
 * keys make running this often harmless — a tenant never has two of either pending.
 */
export async function scheduleDueJobs(
  env: Record<string, string | undefined> = process.env
): Promise<number> {
  let queued = 0;
  for (const tenantId of await pendingEmailTenants()) {
    const job = await enqueueJob(tenantId, {
      kind: 'notify_deliver',
      dedupeKey: `notify:${tenantId}`,
    });
    if (job) queued += 1;
  }
  // Digests go out once a day, during the configured UTC hour (default 03:00 UTC, about
  // 08:30 in India); digest_runs keeps a user from getting two.
  const digestHour = Number(env.DIGEST_HOUR_UTC ?? 3);
  if (new Date().getUTCHours() === digestHour) {
    const tenants = new Set((await dueDigestRecipients()).map((r) => r.tenant_id));
    for (const tenantId of tenants) {
      const job = await enqueueJob(tenantId, {
        kind: 'notify_digest',
        dedupeKey: `digest:${tenantId}`,
      });
      if (job) queued += 1;
    }
  }
  await pruneGithubDeliveries();
  return queued;
}

/** Runs one job if there is one. Returns the job it ran, or null when the queue was empty. */
export async function runNextJob(
  handlers: Partial<Record<JobKind, JobHandler>> = defaultHandlers,
  log: (line: string) => void = console.log
): Promise<JobRow | null> {
  const job = await claimJob();
  if (!job) return null;

  const label = `${job.kind} ${job.id} (attempt ${job.attempts})`;
  log(`start  ${label}`);
  try {
    const handler = handlers[job.kind] ?? defaultHandlers[job.kind];
    // A job queued by an older build (a removed Jira import) has no handler here any more.
    if (!handler) throw new PermanentJobError(`No handler for job kind ${job.kind}.`);
    const progress = await handler(job);
    await completeJob(job.tenant_id, job.id, { ...progress });
    log(`done   ${label} ${JSON.stringify(progress)}`);
  } catch (error) {
    const permanent = error instanceof PermanentJobError;
    const message = error instanceof Error ? error.message : String(error);
    const status = await failJob(job.tenant_id, job.id, message, { retryable: !permanent });
    log(`${status === 'queued' ? 'retry ' : 'failed'} ${label}: ${message}`);
  }
  return job;
}

/** Drains the queue until `signal` aborts, polling every `idleMs` when it is empty. */
export async function runWorker(
  options: { signal?: AbortSignal; idleMs?: number; log?: (line: string) => void } = {}
): Promise<void> {
  const idleMs = options.idleMs ?? 2_000;
  const log = options.log ?? console.log;
  let lastSchedule = 0;
  while (!options.signal?.aborted) {
    let ran: JobRow | null = null;
    try {
      if (Date.now() - lastSchedule > 60_000) {
        lastSchedule = Date.now();
        const queued = await scheduleDueJobs();
        if (queued > 0) log(`scheduled ${queued} recurring job(s)`);
      }
      ran = await runNextJob(defaultHandlers, log);
    } catch (error) {
      // The queue itself is unreachable (database down): wait and try again.
      log(`queue error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!ran) await sleep(idleMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
