/**
 * Live Jira sync (Milestone C): keeping imported projects current after the backfill.
 *
 *   jira_issue_sync    one issue, queued by the webhook receiver. The delivery is only a
 *                      signal: the issue is re-read through the API, so a forged, stale or
 *                      out-of-order delivery can at worst cause a harmless re-read.
 *   jira_reconcile     every tenant on a timer: issues updated since the last reconcile.
 *                      Catches deliveries Jira gave up on, and is the whole live path on a
 *                      server Jira cannot reach (localhost).
 *   jira_webhook_sync  registers the tenant's one webhook (OAuth apps get five per site),
 *                      re-registers it when the project list changes, refreshes it before
 *                      its 30-day expiry. Skipped without a public HTTPS base URL.
 *
 * None of these ever analyzes. A changed ticket becomes a new version with its old flags
 * marked stale, and is analyzed only when an admin starts a batch.
 */
import {
  archiveJiraTicket,
  checkpointJob,
  deleteTenantWebhookRow,
  getReconcileState,
  getSyncProject,
  getTenantWebhook,
  ingestTicket,
  liveJiraProjects,
  markReconciled,
  notifyTicketEvent,
  saveTenantWebhook,
  setJiraTicketMeta,
  setProjectSyncStatus,
  setTenantWebhookExpiry,
  type JobRow,
  type LiveProjectRow,
} from '@specfix/db';
import {
  deleteWebhooks,
  getIssue,
  normalizeJiraIssue,
  reconcileJql,
  refreshWebhooks,
  registerWebhook,
  searchIssues,
  webhookJql,
  type JiraClient,
  type JiraIssue,
} from '@specfix/ingest';
import { jiraClientFor } from './jira-access.ts';
import { PermanentJobError } from './errors.ts';

export interface LiveDeps {
  clientFor: (tenantId: string) => Promise<{ client: JiraClient; cloudId: string }>;
  /** Called when a sync created a new version of a ticket (Milestone E notifies on it). */
  onNewVersion: (tenantId: string, ticketId: string, staledFlags: number) => Promise<void>;
  /** Public HTTPS origin Jira can deliver to, or null when there is none. */
  publicBaseUrl: string | null;
}

export function publicBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export const defaultLiveDeps = (): LiveDeps => ({
  clientFor: jiraClientFor,
  onNewVersion: async (tenantId, ticketId, staledFlags) => {
    // Only worth interrupting someone when decisions they already made went stale.
    if (staledFlags > 0) {
      await notifyTicketEvent(tenantId, {
        kind: 'flags_stale',
        ticketId,
        details: { staled: staledFlags },
      });
    }
  },
  publicBaseUrl: publicBaseUrlFromEnv(),
});

/** Ingests one fetched issue into whichever synced project it belongs to. */
async function applyIssue(
  tenantId: string,
  issue: JiraIssue,
  projects: readonly LiveProjectRow[],
  deps: LiveDeps
): Promise<'new' | 'unchanged' | 'archived'> {
  const project = projects.find((p) => p.jira_project_key === issue.fields.project?.key);
  if (!project) {
    // Moved to a project SpecFix does not sync.
    await archiveJiraTicket(tenantId, issue.id);
    return 'archived';
  }
  const { ticket, meta } = normalizeJiraIssue(issue, project.ac_field_id);
  const result = await ingestTicket(tenantId, project.id, ticket);
  await setJiraTicketMeta(tenantId, result.ticket.id, meta);
  if (!result.isNewVersion) return 'unchanged';
  await deps.onNewVersion(tenantId, result.ticket.id, result.staledFlagCount);
  return 'new';
}

function acFieldsOf(projects: readonly LiveProjectRow[]): string[] {
  return [...new Set(projects.map((p) => p.ac_field_id).filter((f): f is string => !!f))];
}

export async function runIssueSync(
  job: JobRow,
  deps: LiveDeps = defaultLiveDeps()
): Promise<{ outcome: 'new' | 'unchanged' | 'archived' | 'ignored' }> {
  const tenantId = job.tenant_id;
  const issueId = typeof job.payload.issueId === 'string' ? job.payload.issueId : '';
  if (!/^\d+$/.test(issueId)) throw new PermanentJobError('Issue sync job has no issue id.');

  const projects = await liveJiraProjects(tenantId);
  if (projects.length === 0) return { outcome: 'ignored' };
  const { client } = await deps.clientFor(tenantId);

  // One custom AC field per request is enough in practice; with several projects using
  // different fields, the issue is re-read with its own project's field.
  const fields = acFieldsOf(projects);
  let issue = await getIssue(client, issueId, fields[0] ?? null);
  if (!issue) {
    const archived = await archiveJiraTicket(tenantId, issueId);
    return { outcome: archived > 0 ? 'archived' : 'ignored' };
  }
  const own = projects.find((p) => p.jira_project_key === issue!.fields.project?.key);
  if (own?.ac_field_id && own.ac_field_id !== fields[0]) {
    issue = (await getIssue(client, issueId, own.ac_field_id)) ?? issue;
  }
  return { outcome: await applyIssue(tenantId, issue, projects, deps) };
}

/** Minutes to look back: since the last reconcile, plus overlap; a day the first time. */
function lookbackMinutes(last: Date | null, now: Date): number {
  if (!last) return 24 * 60;
  return Math.min((now.getTime() - last.getTime()) / 60_000 + 5, 30 * 24 * 60);
}

export async function runReconcile(
  job: JobRow,
  deps: LiveDeps = defaultLiveDeps()
): Promise<{ seen: number; newVersions: number; archived: number }> {
  const tenantId = job.tenant_id;
  const startedAt = new Date();
  const projects = await liveJiraProjects(tenantId);
  const state = await getReconcileState(tenantId);
  const progress = { seen: 0, newVersions: 0, archived: 0 };
  if (projects.length === 0 || !state) return progress;

  const { client } = await deps.clientFor(tenantId);
  const jql = reconcileJql(
    projects.map((p) => p.jira_project_key),
    lookbackMinutes(state.last_reconciled_at, startedAt)
  );
  const field = acFieldsOf(projects)[0] ?? null;

  let token: string | null = null;
  do {
    const page = await searchIssues(client, { jql, acFieldId: field, nextPageToken: token });
    for (const issue of page.issues) {
      progress.seen += 1;
      try {
        const outcome = await applyIssue(tenantId, issue, projects, deps);
        if (outcome === 'new') progress.newVersions += 1;
        if (outcome === 'archived') progress.archived += 1;
      } catch {
        // One malformed issue must not stop the rest; the next reconcile retries it.
      }
    }
    token = page.nextPageToken;
    await checkpointJob(tenantId, job.id, { progress: { ...progress } });
  } while (token);

  // Only advance the mark after a complete pass, from when the pass started.
  await markReconciled(tenantId, startedAt);
  for (const p of projects) {
    const row = await getSyncProject(tenantId, p.id);
    if (row && row.sync_status !== 'backfilling') {
      await setProjectSyncStatus(tenantId, p.id, 'live', { synced: true });
    }
  }
  return progress;
}

export async function runWebhookSync(
  job: JobRow,
  deps: LiveDeps = defaultLiveDeps()
): Promise<{ action: 'skipped' | 'registered' | 'refreshed' | 'removed' | 'unchanged' }> {
  const tenantId = job.tenant_id;
  if (!deps.publicBaseUrl) return { action: 'skipped' };

  const projects = await liveJiraProjects(tenantId);
  const state = await getReconcileState(tenantId);
  const existing = await getTenantWebhook(tenantId);
  const { client } = await deps.clientFor(tenantId);

  if (projects.length === 0 || !state) {
    if (existing) {
      await deleteWebhooks(client, [Number(existing.jira_webhook_id)]).catch(() => {});
      await deleteTenantWebhookRow(tenantId);
      return { action: 'removed' };
    }
    return { action: 'unchanged' };
  }

  const jql = webhookJql(projects.map((p) => p.jira_project_key));
  const url = `${deps.publicBaseUrl}/api/jira/webhook/${state.connection_id}`;

  if (existing && existing.jql === jql && existing.url === url) {
    if (existing.expires_at.getTime() - Date.now() > 7 * 86_400_000) return { action: 'unchanged' };
    const expiresAt = await refreshWebhooks(client, [Number(existing.jira_webhook_id)]);
    await setTenantWebhookExpiry(tenantId, expiresAt);
    return { action: 'refreshed' };
  }

  if (existing) {
    // The old one would keep firing for a stale project list; it may already be gone.
    await deleteWebhooks(client, [Number(existing.jira_webhook_id)]).catch(() => {});
  }
  const id = await registerWebhook(client, { url, jql });
  await saveTenantWebhook(tenantId, {
    connectionId: state.connection_id,
    jiraWebhookId: id,
    jql,
    url,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
  return { action: 'registered' };
}
