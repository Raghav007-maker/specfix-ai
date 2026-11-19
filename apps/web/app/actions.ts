'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  listMembershipsForUser,
  createProject,
  ProjectAdminError,
  ProjectLimitError,
  AnalysisError,
  requestAnalysisBatch,
} from '@/lib/repos';
import { analysisModel, analyzeBatchLimit } from '@specfix/sync';
import { isAppOwner } from '@/lib/plan';
import { TENANT_COOKIE } from '@/lib/tenant';

/** Switch the active tenant. The target is validated against the user's actual
 * memberships, so the cookie can never point at a tenant they don't belong to. */
export async function switchTenant(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenantId = String(formData.get('tenantId') ?? '');

  const memberships = await listMembershipsForUser(user.id);
  if (!memberships.some((m) => m.tenant_id === tenantId)) {
    redirect('/');
  }

  const cookieStore = await cookies();
  cookieStore.set(TENANT_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
  redirect('/');
}

/**
 * Add a project to the current tenant. Owners only; they may name the project's admin right away. Free allows five. Posted from Home
 * (the first project) or the Projects page (`from=projects`), and a refusal returns there.
 */
export async function createProjectForCurrentTenant(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const name = String(formData.get('name') ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const back = formData.get('from') === 'projects' ? '/projects' : '/';

  if (tenant.role !== 'owner') {
    redirect(`${back}?error=` + encodeURIComponent('Only owners can create projects.'));
  }

  if (!name) {
    redirect(`${back}?error=` + encodeURIComponent('A project name is required.'));
  }
  if (name.length > 100) {
    redirect(
      `${back}?error=` + encodeURIComponent('A project name can be at most 100 characters.')
    );
  }

  let projectId: string;
  try {
    projectId = (
      await createProject(
        tenant.tenant_id,
        { name, sourceType: 'file' },
        {
          unlimited: isAppOwner(user),
          adminId: String(formData.get('adminId') ?? '') || undefined,
          addedBy: user.id,
        }
      )
    ).id;
  } catch (error) {
    if (error instanceof ProjectLimitError || error instanceof ProjectAdminError)
      redirect(`${back}?error=` + encodeURIComponent(error.message));
    throw error;
  }
  redirect(back === '/projects' ? `/projects/${projectId}` : `/?project=${projectId}`);
}

/**
 * Queues one analysis batch for a project's spec queue. The batch size and the tickets in it
 * are decided here on the server, from the current candidates — never from the form — and
 * capped by ANALYZE_BATCH_LIMIT. Only owners and admins (re-checked in the repository).
 */
export async function analyzeProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const projectId = String(formData.get('projectId') ?? '');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const back = UUID.test(projectId) ? `/?project=${projectId}&tab=reviews` : '/?tab=reviews';
  let message: { error?: string; notice?: string };
  try {
    if (!analysisModel().priced) {
      throw new AnalysisError('The analysis model has no known price, so analysis is off.');
    }
    const queued = await requestAnalysisBatch(
      tenant.tenant_id,
      user.id,
      projectId,
      analyzeBatchLimit()
    );
    message = queued
      ? { notice: `Analysis of ${queued.count} ticket(s) queued.` }
      : { error: 'An analysis batch for this project is already queued or running.' };
  } catch (error) {
    if (!(error instanceof AnalysisError)) throw error;
    message = { error: error.message };
  }
  const params = new URLSearchParams(message as Record<string, string>);
  redirect(`${back}&${params}`);
}
