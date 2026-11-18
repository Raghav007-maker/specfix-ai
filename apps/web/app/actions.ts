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
} from '@/lib/repos';
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
