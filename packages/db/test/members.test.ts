/**
 * Role assignment: who may add, re-role and remove workspace members, and the
 * invariant that a workspace never loses its last owner.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMemberByEmail,
  addMembership,
  assignableRoles,
  canManageMember,
  changeMemberRole,
  closePool,
  createTenant,
  createWorkspace,
  listMembers,
  listProjects,
  query,
  removeMember,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('role policy', () => {
  it('lets owners manage everyone and admins everyone but owners', () => {
    expect(canManageMember('owner', 'owner')).toBe(true);
    expect(canManageMember('admin', 'owner')).toBe(false);
    expect(canManageMember('admin', 'admin')).toBe(true);
    expect(canManageMember('admin', null)).toBe(true);
    expect(canManageMember('reviewer', 'reviewer')).toBe(false);
  });

  it('only lets owners grant owner', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'reviewer']);
    expect(assignableRoles('admin')).toEqual(['admin', 'reviewer']);
    expect(assignableRoles('reviewer')).toEqual([]);
  });
});

describe.skipIf(!hasDatabase)('workspace members', () => {
  let tenantId: string;
  const label = `members-${Date.now()}`;
  const users: Record<'owner' | 'admin' | 'reviewer' | 'outsider', { id: string; email: string }> =
    {} as never;

  beforeAll(async () => {
    tenantId = (await createTenant(label)).id;
    for (const key of ['owner', 'admin', 'reviewer', 'outsider'] as const) {
      const email = `${label}-${key}@example.test`;
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [email]
      );
      if (!user) throw new Error('could not create test user');
      users[key] = { id: user.id, email };
    }
    await addMembership(tenantId, users.owner.id, 'owner');
    await addMembership(tenantId, users.admin.id, 'admin');
    await addMembership(tenantId, users.reviewer.id, 'reviewer');
  });

  it('lists members owners first, with their email', async () => {
    const members = await listMembers(tenantId);
    expect(members.map((m) => m.role)).toEqual(['owner', 'admin', 'reviewer']);
    expect(members[0]?.email).toBe(users.owner.email);
  });

  it('refuses a reviewer who tries to change roles', async () => {
    await expect(
      changeMemberRole(tenantId, users.reviewer.id, { userId: users.admin.id, role: 'reviewer' })
    ).rejects.toThrow(/cannot change/);
  });

  it('refuses an admin who tries to touch an owner or grant owner', async () => {
    await expect(
      changeMemberRole(tenantId, users.admin.id, { userId: users.owner.id, role: 'reviewer' })
    ).rejects.toThrow(/cannot change/);
    await expect(
      changeMemberRole(tenantId, users.admin.id, { userId: users.reviewer.id, role: 'owner' })
    ).rejects.toThrow(/cannot change/);
  });

  it('refuses changing your own role', async () => {
    await expect(
      changeMemberRole(tenantId, users.admin.id, { userId: users.admin.id, role: 'reviewer' })
    ).rejects.toThrow(/own role/);
  });

  it('adds a registered user by email, once', async () => {
    const added = await addMemberByEmail(tenantId, users.admin.id, {
      email: users.outsider.email.toUpperCase(),
      role: 'reviewer',
    });
    expect(added.role).toBe('reviewer');
    await expect(
      addMemberByEmail(tenantId, users.admin.id, { email: users.outsider.email, role: 'admin' })
    ).rejects.toThrow(/already a member/);
    await expect(
      addMemberByEmail(tenantId, users.admin.id, {
        email: `${label}-nobody@example.test`,
        role: 'reviewer',
      })
    ).rejects.toThrow(/sign up first/);
  });

  it('lets an admin promote and remove a non-owner', async () => {
    await changeMemberRole(tenantId, users.admin.id, { userId: users.outsider.id, role: 'admin' });
    await removeMember(tenantId, users.admin.id, users.outsider.id);
    const members = await listMembers(tenantId);
    expect(members.some((m) => m.user_id === users.outsider.id)).toBe(false);
  });

  it('lets one owner hand ownership to another and step the first one down', async () => {
    await changeMemberRole(tenantId, users.owner.id, { userId: users.admin.id, role: 'owner' });
    await changeMemberRole(tenantId, users.admin.id, { userId: users.owner.id, role: 'admin' });
    const roles = Object.fromEntries((await listMembers(tenantId)).map((m) => [m.user_id, m.role]));
    expect(roles[users.admin.id]).toBe('owner');
    expect(roles[users.owner.id]).toBe('admin');
    // The demoted owner is now an admin and can no longer touch the remaining owner.
    await expect(removeMember(tenantId, users.owner.id, users.admin.id)).rejects.toThrow(
      /cannot remove/
    );
  });

  it('refuses demoting an owner to admin or reviewer when the seat limit is reached', async () => {
    const capLabel = `members-cap-${Date.now()}`;
    const capTenant = (await createTenant(capLabel)).id;
    const mkUser = async (suffix: string) => {
      const email = `${capLabel}-${suffix}@example.test`;
      const [u] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [email]
      );
      return { id: u!.id, email };
    };
    const o1 = await mkUser('o1');
    const o2 = await mkUser('o2');
    await addMembership(capTenant, o1.id, 'owner');
    await addMembership(capTenant, o2.id, 'owner');

    const seats: Array<{ id: string; email: string }> = [];
    for (let i = 0; i < 5; i++) {
      const u = await mkUser(`s${i}`);
      seats.push(u);
      await addMembership(capTenant, u.id, 'reviewer');
    }

    // Free plan allows 5 admins + reviewers; demoting a 2nd owner cannot bypass it.
    await expect(
      changeMemberRole(capTenant, o1.id, { userId: o2.id, role: 'admin' })
    ).rejects.toThrow(/Free plan allows 5/);
    await expect(
      changeMemberRole(capTenant, o1.id, { userId: o2.id, role: 'reviewer' })
    ).rejects.toThrow(/Free plan allows 5/);

    // Re-rolling an existing non-owner (reviewer -> admin) at the cap stays allowed.
    await changeMemberRole(capTenant, o1.id, { userId: seats[0]!.id, role: 'admin' });

    // Remove one seat so 4/5 are used; parallel add + owner demotion can only fill 1 seat.
    await removeMember(capTenant, o1.id, seats[4]!.id);
    const late = await mkUser('late');
    const race = await Promise.allSettled([
      addMemberByEmail(capTenant, o1.id, { email: late.email, role: 'reviewer' }),
      changeMemberRole(capTenant, o1.id, { userId: o2.id, role: 'reviewer' }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const nonOwners = (await listMembers(capTenant)).filter((m) => m.role !== 'owner');
    expect(nonOwners).toHaveLength(5);
  });
});

describe.skipIf(!hasDatabase)('createWorkspace', () => {
  it('creates the tenant, its owner and a project together', async () => {
    const label = `workspace-${Date.now()}`;
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}@example.test`]
    );
    if (!user) throw new Error('could not create test user');

    const tenant = await createWorkspace(user.id, { tenantName: label, projectName: 'First' });

    const members = await listMembers(tenant.id);
    expect(members.map((m) => [m.user_id, m.role])).toEqual([[user.id, 'owner']]);
    expect((await listProjects(tenant.id)).map((p) => p.name)).toEqual(['First']);
  });

  it('leaves no tenant behind when a later insert fails', async () => {
    const label = `workspace-orphan-${Date.now()}`;
    // No such user, so the membership insert breaks its foreign key after the tenant insert.
    await expect(
      createWorkspace('00000000-0000-0000-0000-000000000000', {
        tenantName: label,
        projectName: 'First',
      })
    ).rejects.toThrow();
    const left = await query(`select 1 from tenants where name = $1`, [label]);
    expect(left).toHaveLength(0);
  });
});
