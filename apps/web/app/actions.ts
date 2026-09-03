'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { listMembershipsForUser, createProject } from '@/lib/repos';
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
  cookieStore.set(TENANT_COOKIE, tenantId, { httpOnly: true, sameSite: 'lax', path: '/' });
  redirect('/');
}

/** Add a project to the current tenant. */
export async function createProjectForCurrentTenant(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const name = String(formData.get('name') ?? '').trim();

  if (!name) {
    redirect('/?error=' + encodeURIComponent('A project name is required.'));
  }

  const project = await createProject(tenant.tenant_id, { name, sourceType: 'file' });
  redirect(`/?project=${project.id}`);
}
