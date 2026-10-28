'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { markNotificationsRead, setNotificationPrefs } from '@/lib/repos';

/** Inbox actions. Every query is scoped to the signed-in user in their current workspace. */

async function actor() {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  return { userId: user.id, tenantId: tenant.tenant_id };
}

export async function markReadAction(formData: FormData): Promise<void> {
  const { userId, tenantId } = await actor();
  const id = String(formData.get('id') ?? '');
  await markNotificationsRead(tenantId, userId, /^[0-9a-f-]{36}$/i.test(id) ? id : null);
  const to = String(formData.get('to') ?? '');
  // Only ever an in-app path, so a crafted form cannot redirect off-site.
  redirect(/^\/tickets\/[0-9a-f-]{36}$/i.test(to) ? to : '/inbox');
}

export async function markAllReadAction(): Promise<void> {
  const { userId, tenantId } = await actor();
  await markNotificationsRead(tenantId, userId, null);
  redirect('/inbox');
}

export async function savePrefsAction(formData: FormData): Promise<void> {
  const { userId, tenantId } = await actor();
  await setNotificationPrefs(tenantId, userId, {
    email_instant: formData.get('email_instant') === 'on',
    email_digest: formData.get('email_digest') === 'on' ? 'daily' : 'off',
  });
  redirect('/inbox?saved=1');
}
