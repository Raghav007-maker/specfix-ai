/**
 * The background job queue (sync_jobs), drained by the worker.
 *
 * Postgres, not Redis (Jira plan D1): a claim is one UPDATE over a SKIP LOCKED
 * subquery, so two workers never take the same job, and a job's progress is a row
 * the settings page can read. A claimed job holds a lease; a handler that is still
 * working renews it through checkpointJob, and a worker that dies simply lets it lapse
 * so another worker reclaims the job and resumes from the saved payload.
 *
 * claimJob is the one function here that is not tenant-scoped: the worker serves every
 * tenant. Everything a handler does after claiming is scoped by the job's tenant_id.
 */
import type { PoolClient } from 'pg';
import { query, type TenantId } from '../client.ts';

export const JOB_KINDS = [
  'jira_backfill',
  'analyze_batch',
  'jira_issue_sync',
  'jira_reconcile',
  'jira_webhook_sync',
  'notify_deliver',
  'notify_digest',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  kind: JobKind;
  payload: Record<string, unknown>;
  progress: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  requested_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_COLUMNS = `id, tenant_id, project_id, kind, payload, progress, status, attempts,
                     max_attempts, last_error, requested_by, created_at, started_at, finished_at`;

/** How long a claim lasts without a checkpoint. */
export const JOB_LEASE_MS = 5 * 60_000;

export class JobError extends Error {}

/**
 * Queues a job. With a dedupe key, a job already queued or running under the same key
 * wins and this returns null instead of adding a second one.
 */
export async function enqueueJob(
  tenantId: TenantId,
  input: {
    kind: JobKind;
    projectId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string | null;
    requestedBy?: string | null;
    maxAttempts?: number;
  },
  /** Pass a transaction's client to enqueue atomically with other writes. */
  client?: PoolClient
): Promise<JobRow | null> {
  const run = client
    ? async (sql: string, params: unknown[]) => (await client.query<JobRow>(sql, params)).rows
    : (sql: string, params: unknown[]) => query<JobRow>(sql, params);
  const [row] = await run(
    `insert into sync_jobs (tenant_id, project_id, kind, payload, dedupe_key, requested_by,
                            max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, dedupe_key)
       where status in ('queued', 'running') and dedupe_key is not null
     do nothing
     returning ${JOB_COLUMNS}`,
    [
      tenantId,
      input.projectId ?? null,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
      input.requestedBy ?? null,
      input.maxAttempts ?? 3,
    ]
  );
  return row ?? null;
}

/**
 * Takes the next runnable job: a queued one whose time has come, or a running one
 * whose lease lapsed (its worker died). Returns null when there is nothing to do.
 */
export async function claimJob(): Promise<JobRow | null> {
  // A lapsed job that has used every attempt is failed, not run again: its worker kept
  // dying on it, and an analysis batch must never re-run past its one attempt.
  await query(
    `update sync_jobs set status = 'failed', finished_at = now(), locked_until = null,
                          last_error = coalesce(last_error, 'The worker stopped responding.')
     where status = 'running' and locked_until < now() and attempts >= max_attempts`
  );
  const [row] = await query<JobRow>(
    `update sync_jobs set
       status = 'running',
       attempts = attempts + 1,
       started_at = coalesce(started_at, now()),
       locked_until = now() + make_interval(secs => $1)
     where id = (
       select id from sync_jobs
       where (status = 'queued' and run_after <= now())
          or (status = 'running' and locked_until < now())
       order by run_after
       for update skip locked
       limit 1
     )
     returning ${JOB_COLUMNS}`,
    [JOB_LEASE_MS / 1000]
  );
  return row ?? null;
}

/** Saves resumable state and progress, and renews the lease. */
export async function checkpointJob(
  tenantId: TenantId,
  jobId: string,
  input: { payload?: Record<string, unknown>; progress?: Record<string, unknown> }
): Promise<void> {
  await query(
    `update sync_jobs set
       payload = coalesce($3::jsonb, payload),
       progress = progress || coalesce($4::jsonb, '{}'::jsonb),
       locked_until = now() + make_interval(secs => $5)
     where tenant_id = $1 and id = $2 and status = 'running'`,
    [
      tenantId,
      jobId,
      input.payload ? JSON.stringify(input.payload) : null,
      input.progress ? JSON.stringify(input.progress) : null,
      JOB_LEASE_MS / 1000,
    ]
  );
}

export async function completeJob(
  tenantId: TenantId,
  jobId: string,
  progress: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `update sync_jobs set status = 'done', finished_at = now(), locked_until = null,
                          last_error = null, progress = progress || $3::jsonb
     where tenant_id = $1 and id = $2`,
    [tenantId, jobId, JSON.stringify(progress)]
  );
}

/**
 * Records a failure. A retryable one goes back on the queue with exponential backoff
 * until max_attempts is used up; a permanent one (or the last attempt) fails the job.
 */
export async function failJob(
  tenantId: TenantId,
  jobId: string,
  error: string,
  options: { retryable: boolean }
): Promise<JobStatus> {
  const [row] = await query<{ status: JobStatus }>(
    `update sync_jobs set
       status = case when $4 and attempts < max_attempts then 'queued' else 'failed' end,
       run_after = now() + make_interval(secs => least(30 * power(2, attempts), 1800)),
       finished_at = case when $4 and attempts < max_attempts then null else now() end,
       locked_until = null,
       last_error = $3
     where tenant_id = $1 and id = $2
     returning status`,
    [tenantId, jobId, error.slice(0, 500), options.retryable]
  );
  if (!row) throw new JobError(`no such job: ${jobId}`);
  return row.status;
}

/** The newest job of each kind for each project, for the settings page. */
export async function latestProjectJobs(tenantId: TenantId): Promise<JobRow[]> {
  return query<JobRow>(
    `select distinct on (project_id, kind) ${JOB_COLUMNS}
     from sync_jobs
     where tenant_id = $1 and project_id is not null
     order by project_id, kind, created_at desc`,
    [tenantId]
  );
}
