'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  MembershipError,
  addMemberByEmail,
  changeMemberRole,
  isRole,
  removeMember,
} from '@/lib/repos';

/**
 * Team management. Each action resolves the user and their current tenant first; the
 * repository then re-reads the actor's role inside its own transaction, so a stale
 * page (or a hand-built form post) cannot grant more than the actor actually holds.
 */

export async function addMemberAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const email = String(formData.get('email') ?? '');
  const role = formData.get('role');
  if (!isRole(role)) back('Choose a role for the new member.');

  const outcome = await run(() => addMemberByEmail(tenantId, user.id, { email, role }));
  if (outcome) back(outcome);
  back(undefined, `Added ${email.trim()} as ${role}.`);
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const userId = String(formData.get('userId') ?? '');
  const email = String(formData.get('email') ?? 'member');
  const role = formData.get('role');
  if (!isRole(role)) back('Choose a valid role.');

  const outcome = await run(() => changeMemberRole(tenantId, user.id, { userId, role }));
  if (outcome) back(outcome);
  back(undefined, `${email} is now ${role === 'admin' ? 'an' : 'a'} ${role}.`);
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const userId = String(formData.get('userId') ?? '');
  const email = String(formData.get('email') ?? 'member');

  const outcome = await run(() => removeMember(tenantId, user.id, userId));
  if (outcome) back(outcome);
  back(undefined, `Removed ${email} from the workspace.`);
}

async function actor() {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  return { user, tenantId: tenant.tenant_id };
}

/** Runs a membership write; returns the refusal message, or null on success. */
async function run(write: () => Promise<unknown>): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (error) {
    if (error instanceof MembershipError) return error.message;
    throw error;
  }
}

function back(error?: string, notice?: string): never {
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  if (notice) params.set('notice', notice);
  redirect(`/team?${params.toString()}`);
}
