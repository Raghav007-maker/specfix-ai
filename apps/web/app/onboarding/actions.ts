'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { createTenant, addMembership, createProject } from '@/lib/repos';
import { TENANT_COOKIE } from '@/lib/tenant';

/**
 * First-run setup for a user who belongs to no tenant yet: create the workspace,
 * make them its owner, and give it one file-sourced project to ingest tickets into.
 * The new tenant becomes the active one via the selection cookie.
 */
export async function createTenantAndProject(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenantName = String(formData.get('tenant') ?? '').trim();
  const projectName = String(formData.get('project') ?? '').trim() || 'Default project';

  if (!tenantName) {
    redirect('/onboarding?error=' + encodeURIComponent('A workspace name is required.'));
  }

  const tenant = await createTenant(tenantName);
  await addMembership(tenant.id, user.id, 'owner');
  await createProject(tenant.id, { name: projectName, sourceType: 'file' });

  const cookieStore = await cookies();
  cookieStore.set(TENANT_COOKIE, tenant.id, { httpOnly: true, sameSite: 'lax', path: '/' });

  redirect('/');
}
