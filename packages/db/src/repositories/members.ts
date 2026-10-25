/**
 * Workspace members and the roles they hold.
 *
 * memberships.role has carried owner / admin / reviewer since the first migration;
 * this module is the write path for changing them from the app. The rules:
 *
 *   - owner     manages everyone, and is the only role that can grant or revoke owner.
 *   - admin     manages admins and reviewers, but cannot touch an owner or make one.
 *   - reviewer  reviews tickets; sees the team but changes nothing.
 *
 * Nobody changes their own role or removes themselves — a one-click self-demotion is
 * a lockout, and a workspace must always keep at least one owner. Both rules are
 * checked inside the transaction that writes, with the tenant's membership rows
 * locked, so two owners demoting each other at once cannot leave the workspace with
 * none.
 */
import type { PoolClient } from 'pg';
import { tx, query, type TenantId } from '../client.ts';

export const ROLES = ['owner', 'admin', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export class MembershipError extends Error {}

/** Whether `actor` may manage a member who holds `target` (null: not yet a member). */
export function canManageMember(actor: Role, target: Role | null): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target !== 'owner';
  return false;
}

/** The roles `actor` may hand out. */
export function assignableRoles(actor: Role): Role[] {
  if (actor === 'owner') return [...ROLES];
  if (actor === 'admin') return ['admin', 'reviewer'];
  return [];
}

export interface MemberRow {
  user_id: string;
  email: string | null;
  role: Role;
  created_at: Date;
}

/** Everyone in the workspace, owners first. Identity comes from auth.users. */
export async function listMembers(tenantId: TenantId): Promise<MemberRow[]> {
  return query<MemberRow>(
    `select m.user_id, u.email, m.role, m.created_at
     from memberships m
     left join auth.users u on u.id = m.user_id
     where m.tenant_id = $1
     order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
              u.email nulls last`,
    [tenantId]
  );
}

/**
 * Adds an already-registered user to the workspace. The person must have signed up
 * first so that Supabase — not this code — owns their password. Adding someone who is
 * already a member is refused rather than silently changing their role.
 */
export async function addMemberByEmail(
  tenantId: TenantId,
  actorId: string,
  input: { email: string; role: Role }
): Promise<MemberRow> {
  const email = input.email.trim();
  if (!email) throw new MembershipError('An email address is required.');

  return tx(async (client) => {
    const actor = await lockedRole(client, tenantId, actorId);
    if (!actor || !canManageMember(actor, null) || !assignableRoles(actor).includes(input.role)) {
      throw new MembershipError(`You cannot add a member as ${input.role}.`);
    }

    const found = await client.query<{ id: string; email: string | null }>(
      `select id, email from auth.users where lower(email) = lower($1)`,
      [email]
    );
    const user = found.rows[0];
    if (!user) {
      throw new MembershipError(
        `No SpecFix account uses ${email}. Ask them to sign up first, then add them here.`
      );
    }

    const inserted = await client.query<MemberRow>(
      `insert into memberships (user_id, tenant_id, role) values ($1, $2, $3)
       on conflict (user_id, tenant_id) do nothing
       returning user_id, role, created_at`,
      [user.id, tenantId, input.role]
    );
    const row = inserted.rows[0];
    if (!row) throw new MembershipError(`${email} is already a member of this workspace.`);
    return { ...row, email: user.email };
  });
}

export async function changeMemberRole(
  tenantId: TenantId,
  actorId: string,
  input: { userId: string; role: Role }
): Promise<void> {
  if (input.userId === actorId) throw new MembershipError('You cannot change your own role.');

  await tx(async (client) => {
    const actor = await lockedRole(client, tenantId, actorId);
    const target = await lockedRole(client, tenantId, input.userId);
    if (!target) throw new MembershipError('That person is not a member of this workspace.');
    if (!actor || !canManageMember(actor, target) || !assignableRoles(actor).includes(input.role)) {
      throw new MembershipError(`You cannot change this member to ${input.role}.`);
    }
    if (target === input.role) return;
    if (target === 'owner') await requireAnotherOwner(client, tenantId);

    await client.query(`update memberships set role = $3 where tenant_id = $1 and user_id = $2`, [
      tenantId,
      input.userId,
      input.role,
    ]);
  });
}

export async function removeMember(
  tenantId: TenantId,
  actorId: string,
  userId: string
): Promise<void> {
  if (userId === actorId) throw new MembershipError('You cannot remove yourself.');

  await tx(async (client) => {
    const actor = await lockedRole(client, tenantId, actorId);
    const target = await lockedRole(client, tenantId, userId);
    if (!target) throw new MembershipError('That person is not a member of this workspace.');
    if (!actor || !canManageMember(actor, target)) {
      throw new MembershipError('You cannot remove this member.');
    }
    if (target === 'owner') await requireAnotherOwner(client, tenantId);

    await client.query(`delete from memberships where tenant_id = $1 and user_id = $2`, [
      tenantId,
      userId,
    ]);
  });
}

/** The user's role in the tenant, with every membership row of the tenant locked. */
async function lockedRole(
  client: PoolClient,
  tenantId: TenantId,
  userId: string
): Promise<Role | null> {
  await client.query(`select 1 from memberships where tenant_id = $1 for update`, [tenantId]);
  const result = await client.query<{ role: Role }>(
    `select role from memberships where tenant_id = $1 and user_id = $2`,
    [tenantId, userId]
  );
  return result.rows[0]?.role ?? null;
}

async function requireAnotherOwner(client: PoolClient, tenantId: TenantId): Promise<void> {
  const result = await client.query<{ owners: string }>(
    `select count(*)::text as owners from memberships where tenant_id = $1 and role = 'owner'`,
    [tenantId]
  );
  if (Number(result.rows[0]?.owners ?? 0) <= 1) {
    throw new MembershipError('A workspace must keep at least one owner.');
  }
}
