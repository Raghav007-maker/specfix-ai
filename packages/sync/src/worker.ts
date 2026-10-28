/**
 * The worker loop: claim a job, run its handler, record the outcome.
 *
 * Which failures are retried: a refused Jira grant or a PermanentJobError is not (the
 * job fails at once and says why); anything else — a network blip, a 429 that outlasted
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
  pruneWebhookDeliveries,
  tenantsDueForReconcile,
  tenantsDueForWebhookSync,
  type JobKind,
  type JobRow,
} from '@specfix/db';
import { JiraAuthError } from '@specfix/ingest';
import { runAnalyzeBatch } from './analyze-batch.ts';
import { runBackfill } from './backfill.ts';
import { PermanentJobError } from './errors.ts';
import { publicBaseUrlFromEnv, runIssueSync, runReconcile, runWebhookSync } from './live.ts';
import { runNotifyDeliver, runNotifyDigest } from './notify.ts';

export type JobHandler = (job: JobRow) => Promise<object>;

export const defaultHandlers: Record<JobKind, JobHandler> = {
  jira_backfill: (job) => runBackfill(job),
  analyze_batch: (job) => runAnalyzeBatch(job),
  jira_issue_sync: (job) => runIssueSync(job),
  jira_reconcile: (job) => runReconcile(job),
  jira_webhook_sync: (job) => runWebhookSync(job),
  notify_deliver: (job) => runNotifyDeliver(job),
  notify_digest: (job) => runNotifyDigest(job),
};

/**
 * How often each tenant reconciles. With webhooks (a public HTTPS URL) reconcile only
 * mops up missed deliveries; without them it is the live path, so it runs often.
 */
export function reconcileIntervalMinutes(
  env: Record<string, string | undefined> = process.env
): number {
  const n = Number(env.JIRA_RECONCILE_MINUTES);
  if (Number.isFinite(n) && n >= 1) return n;
  return publicBaseUrlFromEnv(env) ? 15 : 2;
}

/**
 * Queues the recurring work that has come due: reconciles, and webhook registration or
 * refresh where a public URL exists. Dedupe keys make running this often harmless —
 * a tenant never has two reconciles pending.
 */
export async function scheduleDueJobs(
  env: Record<string, string | undefined> = process.env
): Promise<number> {
  let queued = 0;
  for (const tenantId of await tenantsDueForReconcile(reconcileIntervalMinutes(env))) {
    const job = await enqueueJob(tenantId, {
      kind: 'jira_reconcile',
      dedupeKey: `reconcile:${tenantId}`,
      maxAttempts: 2,
    });
    if (job) queued += 1;
  }
  if (publicBaseUrlFromEnv(env)) {
    for (const tenantId of await tenantsDueForWebhookSync()) {
      const job = await enqueueJob(tenantId, {
        kind: 'jira_webhook_sync',
        dedupeKey: `webhook:${tenantId}`,
        maxAttempts: 3,
      });
      if (job) queued += 1;
    }
  }
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
  await pruneWebhookDeliveries();
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
    const progress = await handler(job);
    await completeJob(job.tenant_id, job.id, { ...progress });
    log(`done   ${label} ${JSON.stringify(progress)}`);
  } catch (error) {
    const permanent = error instanceof PermanentJobError || error instanceof JiraAuthError;
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
