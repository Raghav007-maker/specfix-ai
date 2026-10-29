'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { GithubConnectionError, disconnectGithub, setGithubRepoProject } from '@/lib/repos';

/**
 * GitHub connection settings. The repository re-checks owner/admin inside its
 * transaction and refuses a repository or project id that is not this workspace's, so a
 * hand-built form cannot map another workspace's repository.
 */

type Outcome = { notice: string } | { error: string };

async function run(change: (tenantId: string, userId: string) => Promise<string>): Promise<never> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  let outcome: Outcome;
  try {
    outcome = { notice: await change(tenant.tenant_id, user.id) };
  } catch (error) {
    if (error instanceof GithubConnectionError) {
      outcome = { error: error.message };
    } else {
      console.error('github settings change failed', error);
      outcome = { error: 'Something went wrong. Please try again.' };
    }
  }
  redirect(`/settings/integrations?${new URLSearchParams(outcome).toString()}`);
}

export async function mapGithubRepoAction(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get('repositoryId') ?? '');
  const projectId = String(formData.get('projectId') ?? '');
  await run(async (tenantId, userId) => {
    await setGithubRepoProject(tenantId, userId, repositoryId, projectId || null);
    return projectId ? 'Repository mapped.' : 'Repository unmapped.';
  });
}

export async function disconnectGithubAction(): Promise<void> {
  await run(async (tenantId, userId) => {
    await disconnectGithub(tenantId, userId);
    return 'GitHub disconnected. Uninstall the app on GitHub to revoke its access there too.';
  });
}
