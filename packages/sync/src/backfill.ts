/**
 * jira_backfill: copy a Jira project's issues into SpecFix.
 *
 * Pages through the project's issues updated within its import window, newest first.
 * Each issue goes through ingestTicket — the same idempotent path files use, so an
 * unchanged issue is a no-op and an edited one becomes a new version with its old flags
 * marked stale. After every page the next-page token is checkpointed, so a worker that
 * dies resumes where it stopped rather than re-reading the project.
 *
 * Importing never starts an analysis. New versions are embedded (cheap, and only while
 * the tenant is under its token cap); analysis waits for an admin (see analyze-batch.ts).
 */
import { embedTextsTolerant, getConfig, hasOpenAiCredentials } from '@specfix/core';
import {
  checkpointJob,
  getSyncProject,
  ingestTicket,
  isOverTokenCap,
  markReconciled,
  setJiraTicketMeta,
  setProjectSyncStatus,
  syncClauseEmbeddings,
  syncRequirementEmbeddings,
  type JobRow,
} from '@specfix/db';
import {
  JiraHttpError,
  backfillJql,
  normalizeJiraIssue,
  searchIssues,
  type JiraClient,
} from '@specfix/ingest';
import { jiraClientFor } from './jira-access.ts';
import { PermanentJobError } from './errors.ts';

export interface BackfillDeps {
  clientFor: (tenantId: string) => Promise<{ client: JiraClient; cloudId: string }>;
  /** Embeds new versions. Failures are the embedder's to report; they never fail the import. */
  embed: (tenantId: string, versionIds: string[]) => Promise<void>;
  pageSize?: number;
}

export interface BackfillProgress {
  seen: number;
  newVersions: number;
  unchanged: number;
  skipped: number;
  pages: number;
}

export const defaultBackfillDeps: BackfillDeps = {
  clientFor: jiraClientFor,
  embed: embedIfAffordable,
};

export async function runBackfill(
  job: JobRow,
  deps: BackfillDeps = defaultBackfillDeps
): Promise<BackfillProgress> {
  const tenantId = job.tenant_id;
  if (!job.project_id) throw new PermanentJobError('Backfill job has no project.');
  const project = await getSyncProject(tenantId, job.project_id);
  if (!project) throw new PermanentJobError('The Jira project was removed from the workspace.');

  const { client, cloudId } = await deps.clientFor(tenantId);
  if (cloudId !== project.jira_cloud_id) {
    throw new PermanentJobError(
      'This project belongs to a different Jira site than the one connected now.'
    );
  }

  await setProjectSyncStatus(tenantId, project.id, 'backfilling');
  const jql = backfillJql(project.jira_project_key, project.import_window_days);
  const progress: BackfillProgress = {
    seen: 0,
    newVersions: 0,
    unchanged: 0,
    skipped: 0,
    pages: 0,
    ...(job.progress as Partial<BackfillProgress>),
  };
  let token = typeof job.payload.nextPageToken === 'string' ? job.payload.nextPageToken : null;

  try {
    for (;;) {
      let page;
      try {
        page = await searchIssues(client, {
          jql,
          acFieldId: project.ac_field_id,
          nextPageToken: token,
          pageSize: deps.pageSize ?? 100,
        });
      } catch (error) {
        // A saved page token can expire. Starting over is safe: ingest is idempotent.
        if (token && error instanceof JiraHttpError && error.status === 400) {
          token = null;
          continue;
        }
        throw error;
      }

      const newVersionIds: string[] = [];
      for (const issue of page.issues) {
        progress.seen += 1;
        let normalized;
        try {
          normalized = normalizeJiraIssue(issue, project.ac_field_id);
        } catch {
          progress.skipped += 1;
          continue;
        }
        const result = await ingestTicket(tenantId, project.id, normalized.ticket);
        await setJiraTicketMeta(tenantId, result.ticket.id, normalized.meta);
        if (result.isNewVersion) {
          progress.newVersions += 1;
          newVersionIds.push(result.version.id);
        } else {
          progress.unchanged += 1;
        }
      }
      if (newVersionIds.length > 0) await deps.embed(tenantId, newVersionIds);

      progress.pages += 1;
      token = page.nextPageToken;
      await checkpointJob(tenantId, job.id, {
        payload: { ...job.payload, nextPageToken: token },
        progress: { ...progress },
      });
      if (!token) break;
    }
  } catch (error) {
    await setProjectSyncStatus(tenantId, project.id, 'error');
    throw error;
  }

  // The project is now current, so live sync takes over from here: reconcile looks back
  // only from this moment instead of re-reading the day the backfill just covered.
  await setProjectSyncStatus(tenantId, project.id, 'live', { synced: true });
  await markReconciled(tenantId, new Date());
  return progress;
}

async function embedIfAffordable(tenantId: string, versionIds: string[]): Promise<void> {
  if (!hasOpenAiCredentials() || (await isOverTokenCap(tenantId))) return;
  const deps = { embed: embedTextsTolerant, model: getConfig().modelEmbed };
  await syncRequirementEmbeddings(tenantId, versionIds, deps);
  await syncClauseEmbeddings(tenantId, versionIds, deps);
}
