'use server';

import { redirect } from 'next/navigation';
import {
  JiraAuthError,
  JiraHttpError,
  accessibleResources,
  deleteWebhooks,
  listJiraProjects,
  listJiraTextFields,
} from '@specfix/ingest';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  JiraConnectionError,
  ProjectLimitError,
  addJiraProject,
  disconnectJira,
  getTenantWebhook,
  requestAnalysisBatch,
  requestJiraBackfill,
  setJiraSite,
} from '@/lib/repos';
import { analysisModel, analyzeBatchLimit } from '@specfix/sync';
import { jiraAccess, jiraClientFor } from '@/lib/jira';
import { isAppOwner } from '@/lib/plan';

/**
 * Jira connection settings. Form values are only ever used as lookups into what Jira
 * itself returns for this grant — a posted site id or project key that the grant
 * cannot see is refused, and names and URLs always come from Jira, never the form.
 * The repository re-checks the owner/admin role inside its transaction.
 */

export async function chooseSiteAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const cloudId = String(formData.get('cloudId') ?? '');

  const outcome = await run(async () => {
    const { accessToken } = await jiraAccess(tenantId);
    const site = (await accessibleResources(accessToken)).find((s) => s.cloudId === cloudId);
    if (!site) throw new JiraConnectionError('That Jira site is not available to this connection.');
    await setJiraSite(tenantId, user.id, {
      cloudId: site.cloudId,
      siteUrl: site.url,
      siteName: site.name,
    });
    return `Using ${site.name}.`;
  });
  back(outcome);
}

export async function addJiraProjectAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectKey = String(formData.get('projectKey') ?? '');
  const acFieldId = String(formData.get('acFieldId') ?? '');

  const outcome = await run(async () => {
    const client = await jiraClientFor(tenantId);
    const [projects, fields] = await Promise.all([
      listJiraProjects(client),
      acFieldId ? listJiraTextFields(client) : Promise.resolve([]),
    ]);
    const project = projects.find((p) => p.key === projectKey);
    if (!project) throw new JiraConnectionError('Choose a Jira project from the list.');
    if (acFieldId && !fields.some((f) => f.id === acFieldId)) {
      throw new JiraConnectionError('That acceptance-criteria field no longer exists in Jira.');
    }
    await addJiraProject(
      tenantId,
      user.id,
      { projectKey: project.key, name: project.name, acFieldId: acFieldId || null },
      { unlimited: isAppOwner(user) }
    );
    return `Added ${project.key} · ${project.name}.`;
  });
  back(outcome);
}

export async function disconnectJiraAction(): Promise<void> {
  const { user, tenantId, isAdmin } = await actor();
  const outcome = await run(async () => {
    // Best effort: remove the webhook on Jira's side while the grant still works, so it
    // stops calling. It would otherwise expire on its own within 30 days.
    const webhook = await getTenantWebhook(tenantId).catch(() => null);
    if (webhook && isAdmin) {
      try {
        await deleteWebhooks(await jiraClientFor(tenantId), [Number(webhook.jira_webhook_id)]);
      } catch {
        // The connection may already be broken; disconnecting must still work.
      }
    }
    await disconnectJira(tenantId, user.id);
    return 'Jira disconnected. Its projects stay in the workspace but stop syncing.';
  });
  back(outcome);
}

async function actor() {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  return {
    user,
    tenantId: tenant.tenant_id,
    isAdmin: tenant.role === 'owner' || tenant.role === 'admin',
  };
}

type Outcome = { notice: string } | { error: string };

/** Runs a settings change; known failures become a message, anything else is logged. */
async function run(change: () => Promise<string>): Promise<Outcome> {
  try {
    return { notice: await change() };
  } catch (error) {
    if (
      error instanceof JiraConnectionError ||
      error instanceof ProjectLimitError ||
      error instanceof JiraAuthError ||
      error instanceof JiraHttpError
    ) {
      return { error: error.message };
    }
    console.error('jira settings change failed', error);
    return { error: 'Something went wrong talking to Jira. Please try again.' };
  }
}

function back(outcome: Outcome): never {
  redirect(`/settings/integrations?${new URLSearchParams(outcome).toString()}`);
}

export async function startImportAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = String(formData.get('projectId') ?? '');
  const outcome = await run(async () => {
    const job = await requestJiraBackfill(tenantId, user.id, projectId);
    return job ? 'Import queued.' : 'An import for this project is already queued or running.';
  });
  back(outcome);
}

/**
 * Queues one analysis batch. The batch size and the tickets in it are decided here on
 * the server, from the current candidates — never from the form — and capped by
 * ANALYZE_BATCH_LIMIT.
 */
export async function analyzeAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = String(formData.get('projectId') ?? '');
  const outcome = await run(async () => {
    if (!analysisModel().priced) {
      throw new JiraConnectionError('The analysis model has no known price; analysis is off.');
    }
    const queued = await requestAnalysisBatch(tenantId, user.id, projectId, analyzeBatchLimit());
    return queued
      ? `Analysis of ${queued.count} ticket(s) queued.`
      : 'An analysis batch for this project is already queued or running.';
  });
  back(outcome);
}
