/**
 * What the admin-started analysis reads and writes.
 *
 * Analysis costs money, so it never starts on its own: an admin asks for it, sees how many
 * tickets qualify and what that is estimated to cost, and the batch that runs is the snapshot
 * of version ids taken at that moment, capped in size. Spec tickets come from the portal's own
 * tasks ("Send for spec review"), or from files through the ops script.
 */
import type { PoolClient } from 'pg';
import { tx, query, type TenantId } from '../client.ts';
import { enqueueJob, type JobRow } from './jobs.ts';

/** A refusal whose message is safe to show the admin. */
export class AnalysisError extends Error {}

/** Ticket types never analyzed: containers and fragments, not requirements. */
export const UNANALYZED_ISSUE_TYPES = ['epic', 'sub-task', 'subtask'] as const;

/** A version that failed this many analyses is left alone until someone looks at it. */
export const MAX_FAILED_ANALYSES = 2;

/** Throws unless `userId` is an owner or admin of the tenant; holds their membership row. */
export async function requireTenantAdmin(
  client: Pick<PoolClient, 'query'>,
  tenantId: TenantId,
  userId: string
): Promise<void> {
  const result = await client.query<{ role: string }>(
    `select role from memberships where tenant_id = $1 and user_id = $2 for share`,
    [tenantId, userId]
  );
  const role = result.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') {
    throw new AnalysisError('Only an owner or admin can start analysis.');
  }
}

export interface AnalysisCandidate {
  ticket_id: string;
  ticket_version_id: string;
  external_key: string;
  title: string;
  description_text: string;
  acceptance_criteria_text: string;
}

/**
 * The ticket versions that qualify for analysis in a project: each open ticket's current
 * version, a requirement-shaped type, never successfully analyzed, and not stuck failing.
 * A ticket is in the queue because someone sent it there, so there is no age window.
 */
const CANDIDATES_SQL = `
  with current_versions as (
    select distinct on (v.ticket_id) v.id, v.ticket_id, v.title, v.description_text,
           v.acceptance_criteria_text
    from ticket_versions v
    join tickets t on t.id = v.ticket_id and t.tenant_id = v.tenant_id
    where v.tenant_id = $1 and t.project_id = $2
    order by v.ticket_id, v.captured_at desc
  )
  select cv.ticket_id, cv.id as ticket_version_id, t.external_key, cv.title,
         cv.description_text, cv.acceptance_criteria_text
  from current_versions cv
  join tickets t on t.id = cv.ticket_id and t.tenant_id = $1
  where t.archived_at is null
    and coalesce(t.status_category, '') <> 'done'
    and lower(coalesce(t.issue_type, '')) <> all($3::text[])
    and not exists (
      select 1 from analysis_runs r
      where r.tenant_id = $1 and r.ticket_version_id = cv.id and r.status = 'succeeded'
    )
    and (
      select count(*) from analysis_runs r
      where r.tenant_id = $1 and r.ticket_version_id = cv.id and r.status = 'failed'
    ) < $4
  order by coalesce(t.source_updated_at, t.updated_at) desc, t.external_key`;

export async function countAnalysisCandidates(
  tenantId: TenantId,
  projectId: string
): Promise<number> {
  const [row] = await query<{ n: string }>(
    `select count(*)::text as n from (${CANDIDATES_SQL}) c`,
    [tenantId, projectId, UNANALYZED_ISSUE_TYPES, MAX_FAILED_ANALYSES]
  );
  return Number(row?.n ?? 0);
}

/**
 * Queues analysis of up to `limit` qualifying versions, chosen now. The job carries
 * the version ids, so tickets that qualify later are not silently added to a batch the
 * admin already approved. Returns null if a batch for the project is still pending, or
 * the number of versions queued.
 */
export async function requestAnalysisBatch(
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  limit: number
): Promise<{ job: JobRow; count: number } | null> {
  return tx(async (client) => {
    await requireTenantAdmin(client, tenantId, actorId);
    const { rows } = await client.query<{ ticket_version_id: string }>(
      `${CANDIDATES_SQL} limit $5`,
      [tenantId, projectId, UNANALYZED_ISSUE_TYPES, MAX_FAILED_ANALYSES, limit]
    );
    if (rows.length === 0) throw new AnalysisError('No tickets need analysis right now.');
    const job = await enqueueJob(
      tenantId,
      {
        kind: 'analyze_batch',
        projectId,
        payload: { versionIds: rows.map((r) => r.ticket_version_id) },
        dedupeKey: `analyze:${projectId}`,
        requestedBy: actorId,
        // A failed batch is not retried automatically: every attempt can cost money.
        maxAttempts: 1,
      },
      client
    );
    return job ? { job, count: rows.length } : null;
  });
}

/** The project's most recent analysis batch, or null when there has been none. */
export async function latestAnalysisJob(
  tenantId: TenantId,
  projectId: string
): Promise<JobRow | null> {
  const [row] = await query<JobRow>(
    `select * from sync_jobs
     where tenant_id = $1 and project_id = $2 and kind = 'analyze_batch'
     order by created_at desc limit 1`,
    [tenantId, projectId]
  );
  return row ?? null;
}

/** The listed versions with what analysis needs, plus whether each is already done. */
export async function versionsForAnalysis(
  tenantId: TenantId,
  versionIds: readonly string[]
): Promise<Array<AnalysisCandidate & { analyzed: boolean }>> {
  return query<AnalysisCandidate & { analyzed: boolean }>(
    `select v.ticket_id, v.id as ticket_version_id, t.external_key, v.title,
            v.description_text, v.acceptance_criteria_text,
            exists (
              select 1 from analysis_runs r
              where r.tenant_id = $1 and r.ticket_version_id = v.id and r.status = 'succeeded'
            ) as analyzed
     from ticket_versions v
     join tickets t on t.id = v.ticket_id and t.tenant_id = v.tenant_id
     where v.tenant_id = $1 and v.id = any($2::uuid[])
     order by array_position($2::uuid[], v.id)`,
    [tenantId, versionIds]
  );
}

/**
 * Mean tokens per successful analysis in this tenant, over its recent runs, for the
 * cost estimate shown before an admin starts a batch. Null with no history yet.
 */
export async function recentAnalysisTokenAverage(
  tenantId: TenantId
): Promise<{ input: number; output: number; runs: number } | null> {
  const [row] = await query<{ input: string | null; output: string | null; runs: string }>(
    `select avg(input_tokens)::text as input, avg(output_tokens)::text as output,
            count(*)::text as runs
     from (
       select input_tokens, output_tokens from analysis_runs
       where tenant_id = $1 and status = 'succeeded' and input_tokens > 0
       order by created_at desc limit 50
     ) recent`,
    [tenantId]
  );
  if (!row || Number(row.runs) === 0) return null;
  return { input: Number(row.input), output: Number(row.output), runs: Number(row.runs) };
}

/** Tokens used this calendar month against the tenant's cap. */
export async function tenantTokenBudget(
  tenantId: TenantId
): Promise<{ used: number; cap: number }> {
  const [row] = await query<{ used: string; cap: string }>(
    `select coalesce((select sum(c.input_tokens + c.output_tokens) from llm_calls c
                      where c.tenant_id = t.id
                        and c.created_at >= date_trunc('month', now())), 0)::text as used,
            t.monthly_token_cap::text as cap
     from tenants t where t.id = $1`,
    [tenantId]
  );
  return { used: Number(row?.used ?? 0), cap: Number(row?.cap ?? 0) };
}

export interface AnalysisFailureRow {
  ticket_id: string;
  external_key: string;
  /** The model or client error, as the worker recorded it (at most 500 characters). */
  error: string | null;
  failures: number;
  last_failed_at: Date;
  /** True once the version has failed MAX_FAILED_ANALYSES times and left the queue. */
  given_up: boolean;
}

/**
 * The project's current ticket versions whose analysis failed and never succeeded, newest
 * failure first, with the latest error: what an admin needs to see before trying again.
 */
export async function recentAnalysisFailures(
  tenantId: TenantId,
  projectId: string,
  limit = 5
): Promise<AnalysisFailureRow[]> {
  return query<AnalysisFailureRow>(
    `with current_versions as (
       select distinct on (v.ticket_id) v.id, v.ticket_id
       from ticket_versions v
       join tickets t on t.id = v.ticket_id and t.tenant_id = v.tenant_id
       where v.tenant_id = $1 and t.project_id = $2
       order by v.ticket_id, v.captured_at desc
     )
     select cv.ticket_id, t.external_key,
            (select r.error from analysis_runs r
              where r.tenant_id = $1 and r.ticket_version_id = cv.id and r.status = 'failed'
              order by r.created_at desc limit 1) as error,
            count(r.id)::int as failures,
            max(r.created_at) as last_failed_at,
            count(r.id) >= $3 as given_up
     from current_versions cv
     join tickets t on t.id = cv.ticket_id and t.tenant_id = $1
     join analysis_runs r on r.tenant_id = $1 and r.ticket_version_id = cv.id and r.status = 'failed'
     where not exists (
       select 1 from analysis_runs s
       where s.tenant_id = $1 and s.ticket_version_id = cv.id and s.status = 'succeeded'
     )
     group by cv.ticket_id, cv.id, t.external_key
     order by max(r.created_at) desc
     limit $4`,
    [tenantId, projectId, MAX_FAILED_ANALYSES, Math.min(Math.max(limit, 1), 20)]
  );
}
