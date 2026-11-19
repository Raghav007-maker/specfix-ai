'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { isAppOwner } from '@/lib/plan';
import {
  MembershipError,
  ProjectLimitError,
  RateLimiter,
  RequestError,
  addMemberByEmail,
  changeMemberRole,
  decideJoinRequest,
  decideProjectRequest,
  isRole,
  removeMember,
  requestProject,
  requestProjectJoin,
  requestToJoin,
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

  const outcome = await run(() =>
    addMemberByEmail(tenantId, user.id, { email, role }, { unlimited: isAppOwner(user) })
  );
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
    if (
      error instanceof MembershipError ||
      error instanceof RequestError ||
      error instanceof ProjectLimitError
    ) {
      return error.message;
    }
    throw error;
  }
}

function back(error?: string, notice?: string, page: '/team' | '/join' = '/team'): never {
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  if (notice) params.set('notice', notice);
  redirect(`${page}?${params.toString()}`);
}

const joinByUser = new RateLimiter('team-join', 10, 60 * 60_000);

/** Asks to join a team found by name; the owner decides. */
export async function requestJoinAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  // Someone in no team yet asks from /join, which needs no workspace.
  const page = formData.get('from') === 'join' ? '/join' : '/team';
  if (!(await joinByUser.take(user.id))) {
    back('Too many requests. Try again in an hour.', undefined, page);
  }
  const outcome = await run(() => requestToJoin(user.id, String(formData.get('tenantId') ?? '')));
  if (outcome) back(outcome, undefined, page);
  back(undefined, 'Request sent. The team owner will see it.', page);
}

export async function decideJoinAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const approve = formData.get('decision') === 'approve';
  const outcome = await run(() =>
    decideJoinRequest(tenantId, user.id, String(formData.get('requestId') ?? ''), approve, {
      unlimited: isAppOwner(user),
    })
  );
  if (outcome) back(outcome);
  back(undefined, approve ? 'Added to the team as a reviewer.' : 'Request rejected.');
}

/** A team member asks to join a project; its admin decides. */
export async function requestProjectJoinAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  if (!(await joinByUser.take(user.id))) back('Too many requests. Try again in an hour.');
  const outcome = await run(() =>
    requestProjectJoin(tenantId, user.id, String(formData.get('projectId') ?? ''))
  );
  if (outcome) back(outcome);
  back(undefined, 'Request sent. The project admin will see it.');
}

/** An admin asks the owner for a new project. */
export async function requestProjectAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const outcome = await run(() =>
    requestProject(tenantId, user.id, String(formData.get('name') ?? ''))
  );
  if (outcome) back(outcome);
  back(undefined, 'Sent to the owner for approval.');
}

export async function decideProjectAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const approve = formData.get('decision') === 'approve';
  const outcome = await run(() =>
    decideProjectRequest(tenantId, user.id, String(formData.get('requestId') ?? ''), approve, {
      unlimited: isAppOwner(user),
    })
  );
  if (outcome) back(outcome);
  back(undefined, approve ? 'Project created. The requester is its admin.' : 'Request rejected.');
}
