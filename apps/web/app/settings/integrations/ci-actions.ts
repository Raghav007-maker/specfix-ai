'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { CiTokenError, createCiToken, revokeCiToken } from '@/lib/repos';

/**
 * CI token actions. A new token is returned to the client component that asked for it —
 * never put in a URL or a cookie — so it is visible exactly once, on that screen.
 */

export type CiTokenState = { token?: string; error?: string; projectId?: string };

export async function createCiTokenAction(
  _prev: CiTokenState,
  formData: FormData
): Promise<CiTokenState> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const projectId = String(formData.get('projectId') ?? '');
  try {
    const token = await createCiToken(tenant.tenant_id, user.id, projectId);
    revalidatePath('/settings/integrations');
    return { token, projectId };
  } catch (error) {
    if (error instanceof CiTokenError) return { error: error.message, projectId };
    console.error('creating CI token failed', error);
    return { error: 'Could not create a token. Please try again.', projectId };
  }
}

export async function revokeCiTokenAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  try {
    await revokeCiToken(tenant.tenant_id, user.id, String(formData.get('projectId') ?? ''));
  } catch (error) {
    // A refused revoke (not an admin, unknown project) changes nothing; the page simply
    // re-renders with the token still listed.
    if (!(error instanceof CiTokenError)) throw error;
  }
  revalidatePath('/settings/integrations');
}
