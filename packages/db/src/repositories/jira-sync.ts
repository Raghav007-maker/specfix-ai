/**
 * What the Jira backfill and the admin-started analysis read and write.
 *
 * Two scopes, kept apart on purpose (Jira plan D5). Importing is cheap, so a backfill
 * copies every issue updated within the project's import window. Analysis costs money,
 * so it is never started by an import: an admin asks for it, sees how many tickets
 * qualify and what that is estimated to cost, and the batch that runs is the snapshot
 * of version ids taken at that moment, capped in size.
 */
import { tx, query, type TenantId } from '../client.ts';
import { JiraConnectionError, requireTenantAdmin } from './jira.ts';
import { enqueueJob, type JobRow } from './jobs.ts';

/** Issue types never analyzed: containers and fragments, not requirements. */
export const UNANALYZED_ISSUE_TYPES = ['epic', 'sub-task', 'subtask', 'bug'] as const;

/** A version that failed this many analyses is left alone until someone looks at it. */
export const MAX_FAILED_ANALYSES = 2;

export interface SyncProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  jira_cloud_id: string;
  jira_project_key: string;
  ac_field_id: string | null;
  import_window_days: number;
  analyze_window_days: number;
  sync_status: 'idle' | 'backfilling' | 'live' | 'error';
  last_synced_at: Date | null;
}

export async function getSyncProject(
  tenantId: TenantId,
  projectId: string
): Promise<SyncProjectRow | null> {
  const [row] = await query<SyncProjectRow>(
    `select id, tenant_id, name, jira_cloud_id, jira_project_key, ac_field_id,
            import_window_days, analyze_window_days, sync_status, last_synced_at
     from projects
     where tenant_id = $1 and id = $2 and source_type = 'jira'`,
    [tenantId, projectId]
  );
  return row ?? null;
}

export async function setProjectSyncStatus(
  tenantId: TenantId,
  projectId: string,
  status: SyncProjectRow['sync_status'],
  options: { synced?: boolean } = {}
): Promise<void> {
  await query(
    `update projects
     set sync_status = $3,
         last_synced_at = case when $4 then now() else last_synced_at end
     where tenant_id = $1 and id = $2`,
    [tenantId, projectId, status, options.synced ?? false]
  );
}

export interface JiraTicketMeta {
  issueType: string | null;
  statusName: string | null;
  statusCategory: string | null;
  reporterAccountId: string | null;
  assigneeAccountId: string | null;
}

/** Jira facts that change without changing the requirement; never part of the content hash. */
export async function setJiraTicketMeta(
  tenantId: TenantId,
  ticketId: string,
  meta: JiraTicketMeta
): Promise<void> {
  await query(
    `update tickets
     set issue_type = $3, status_name = $4, status_category = $5,
         reporter_account_id = $6, assignee_account_id = $7, archived_at = null
     where tenant_id = $1 and id = $2`,
    [
      tenantId,
      ticketId,
      meta.issueType,
      meta.statusName,
      meta.statusCategory,
      meta.reporterAccountId,
      meta.assigneeAccountId,
    ]
  );
}

/** Queues an import of the project's issues. A second request while one is pending is a no-op. */
export async function requestJiraBackfill(
  tenantId: TenantId,
  actorId: string,
  projectId: string
): Promise<JobRow | null> {
  return tx(async (client) => {
    await requireTenantAdmin(client, tenantId, actorId);
    const project = await client.query(
      `select 1 from projects
       where tenant_id = $1 and id = $2 and source_type = 'jira'`,
      [tenantId, projectId]
    );
    if (!project.rowCount) throw new JiraConnectionError('That is not a Jira project here.');
    return enqueueJob(
      tenantId,
      {
        kind: 'jira_backfill',
        projectId,
        dedupeKey: `backfill:${projectId}`,
        requestedBy: actorId,
        maxAttempts: 5,
      },
      client
    );
  });
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
 * The ticket versions that qualify for analysis in a project: each ticket's current
 * version, still open in Jira, a requirement-shaped issue type, updated within the
 * analysis window, never successfully analyzed, and not stuck failing.
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
  join projects p on p.id = t.project_id and p.tenant_id = $1
  where t.archived_at is null
    and coalesce(t.status_category, '') <> 'done'
    and lower(coalesce(t.issue_type, '')) <> all($3::text[])
    and coalesce(t.source_updated_at, t.updated_at)
          >= now() - make_interval(days => p.analyze_window_days)
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
    if (rows.length === 0) throw new JiraConnectionError('No tickets need analysis right now.');
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
