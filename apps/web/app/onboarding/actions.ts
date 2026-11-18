'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { forgetUser, requireUser } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { createWorkspace } from '@/lib/repos';
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

  // Optional: the name teammates find you by. Settings → Profile changes it (and the photo) later.
  const personName = String(formData.get('personName') ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (personName.length > 60) {
    redirect('/onboarding?error=' + encodeURIComponent('A name can be at most 60 characters.'));
  }

  const tenant = await createWorkspace(user.id, { tenantName, projectName });

  if (personName) {
    const supabase = await createClient();
    const { error } = await supabase.auth.updateUser({
      data: { full_name: personName, name: personName },
    });
    // Not fatal: the workspace exists, and the name can be set in Settings → Profile.
    if (error) console.error('[onboarding] name not saved:', error.name, error.status ?? 0);
    else forgetUser(user.id);
  }

  const cookieStore = await cookies();
  cookieStore.set(TENANT_COOKIE, tenant.id, { httpOnly: true, sameSite: 'lax', path: '/' });

  redirect('/');
}
