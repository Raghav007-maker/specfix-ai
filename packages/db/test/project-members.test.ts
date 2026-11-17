/**
 * Project-level roles and time logging: the pure rules, and against the test database who can
 * see and change which project — owner vs project admin vs reviewer vs a member of another
 * project vs another workspace — plus the abuse cases (forged ids, self-promotion, duplicates
 * under parallel requests, oversized or malformed time entries).
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProjectAccessError,
  WorkError,
  addMembership,
  addWorkComment,
  canChangeProjectMember,
  closePool,
  createProject,
  createSprint,
  createTenant,
  createWorkItem,
  deleteTimeEntry,
  deleteWorkItem,
  flagBreakdown,
  formatMinutes,
  listProjectMembers,
  listProjectPeople,
  listProjectsForUser,
  listTimeEntries,
  listVisibleProjects,
  listWorkEvents,
  logTime,
  normalizeTimeEntry,
  postProjectMessage,
  projectRole,
  projectTracking,
  query,
  searchWorkItems,
  setProjectMember,
  updateWorkItem,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('project member policy', () => {
  it('lets the owner make any change but a no-op', () => {
    expect(canChangeProjectMember('owner', null, 'admin')).toBe(true);
    expect(canChangeProjectMember('owner', 'admin', 'reviewer')).toBe(true);
    expect(canChangeProjectMember('owner', 'admin', null)).toBe(true);
    expect(canChangeProjectMember('owner', 'admin', 'admin')).toBe(false);
  });

  it('lets an admin add reviewers, promote a reviewer, remove a reviewer — nothing more', () => {
    expect(canChangeProjectMember('admin', null, 'reviewer')).toBe(true);
    expect(canChangeProjectMember('admin', null, 'admin')).toBe(false);
    expect(canChangeProjectMember('admin', 'reviewer', 'admin')).toBe(true);
    expect(canChangeProjectMember('admin', 'reviewer', null)).toBe(true);
    expect(canChangeProjectMember('admin', 'admin', 'reviewer')).toBe(false);
    expect(canChangeProjectMember('admin', 'admin', null)).toBe(false);
  });

  it('lets a reviewer or an outsider change nobody', () => {
    expect(canChangeProjectMember('reviewer', null, 'reviewer')).toBe(false);
    expect(canChangeProjectMember('reviewer', 'reviewer', null)).toBe(false);
    expect(canChangeProjectMember(null, null, 'reviewer')).toBe(false);
  });
});

describe('time entry rules', () => {
  const today = '2026-11-17';

  it('accepts 1–1440 whole minutes, a real recent date and a short note', () => {
    expect(
      normalizeTimeEntry({ minutes: '90', spentOn: today, note: '  wrote  tests ' }, today)
    ).toEqual({ minutes: 90, spentOn: today, note: 'wrote tests' });
    expect(normalizeTimeEntry({ minutes: 1, spentOn: '2026-11-18' }, today).minutes).toBe(1);
    expect(normalizeTimeEntry({ minutes: 1440, spentOn: '2025-11-20' }, today).minutes).toBe(1440);
  });

  it.each([0, -5, 1441, 1.5, 'abc', '', null, Number.NaN, 1e12, '60; drop table time_entries'])(
    'refuses %s minutes',
    (minutes) => {
      expect(() => normalizeTimeEntry({ minutes, spentOn: today }, today)).toThrow(
        ProjectAccessError
      );
    }
  );

  it.each(['', '2026-02-30', '17/11/2026', '2026-11-20', '2024-01-01', "2026-11-17' or 1=1"])(
    'refuses the day %s',
    (spentOn) => {
      expect(() => normalizeTimeEntry({ minutes: 30, spentOn }, today)).toThrow(ProjectAccessError);
    }
  );

  it('refuses a note over 200 characters', () => {
    expect(() =>
      normalizeTimeEntry({ minutes: 30, spentOn: today, note: 'x'.repeat(201) }, today)
    ).toThrow(/200/);
  });

  it('formats minutes as hours', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(95)).toBe('1h 35m');
  });
});

describe.skipIf(!hasDatabase)('project access', () => {
  const label = `pm-${Date.now()}`;
  type Who = 'owner' | 'admin' | 'reviewer' | 'other' | 'idle' | 'outsider';
  const u = {} as Record<Who, string>;
  let tenantId: string;
  let otherTenant: string;
  let alpha: string; // admin + reviewer are in it
  let beta: string; // only `other` is in it
  let foreign: string; // a project of another workspace
  let alphaTask: string;
  let betaTask: string;

  beforeAll(async () => {
    tenantId = (await createTenant(label)).id;
    otherTenant = (await createTenant(`${label}-other`)).id;
    for (const key of ['owner', 'admin', 'reviewer', 'other', 'idle', 'outsider'] as const) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      u[key] = row!.id;
    }
    await addMembership(tenantId, u.owner, 'owner');
    // Workspace roles no longer decide project access: `idle` is a workspace admin in no project.
    for (const key of ['admin', 'reviewer', 'other'] as const) {
      await addMembership(tenantId, u[key], 'reviewer');
    }
    await addMembership(tenantId, u.idle, 'admin');
    await addMembership(otherTenant, u.outsider, 'owner');

    alpha = (await createProject(tenantId, { name: `${label} alpha`, sourceType: 'file' })).id;
    beta = (await createProject(tenantId, { name: `${label} beta`, sourceType: 'file' })).id;
    foreign = (await createProject(otherTenant, { name: `${label} foreign`, sourceType: 'file' }))
      .id;

    await setProjectMember(tenantId, u.owner, { projectId: alpha, userId: u.admin, role: 'admin' });
    await setProjectMember(tenantId, u.admin, {
      projectId: alpha,
      userId: u.reviewer,
      role: 'reviewer',
    });
    await setProjectMember(tenantId, u.owner, { projectId: beta, userId: u.other, role: 'admin' });

    alphaTask = (await createWorkItem(tenantId, u.admin, alpha, { title: 'alpha task' })).id;
    betaTask = (await createWorkItem(tenantId, u.other, beta, { title: 'beta secret' })).id;
  });

  it('shows the owner every project and everyone else only their own', async () => {
    const names = async (who: string) =>
      (await listVisibleProjects(tenantId, who)).map((p) => p.id).sort();
    expect(await names(u.owner)).toEqual([alpha, beta].sort());
    expect(await names(u.admin)).toEqual([alpha]);
    expect(await names(u.reviewer)).toEqual([alpha]);
    expect(await names(u.other)).toEqual([beta]);
    expect(await names(u.idle)).toEqual([]);
    // The user-scoped list never crosses into a workspace the user is not in.
    expect((await listProjectsForUser(u.outsider)).map((p) => p.id)).toEqual([foreign]);
  });

  it('answers each person’s role per project, and null for a project they cannot see', async () => {
    expect(await projectRole(tenantId, alpha, u.owner)).toBe('owner');
    expect(await projectRole(tenantId, alpha, u.admin)).toBe('admin');
    expect(await projectRole(tenantId, alpha, u.reviewer)).toBe('reviewer');
    expect(await projectRole(tenantId, beta, u.admin)).toBeNull();
    expect(await projectRole(tenantId, foreign, u.owner)).toBeNull();
    expect(await projectRole(otherTenant, alpha, u.outsider)).toBeNull();
    expect(await projectRole(tenantId, 'not-a-uuid', u.owner)).toBeNull();
  });

  it('refuses every task write in a project the actor is not in, like a wrong id', async () => {
    await expect(createWorkItem(tenantId, u.admin, beta, { title: 'sneak' })).rejects.toThrow(
      'That project is not in this workspace.'
    );
    await expect(
      updateWorkItem(tenantId, u.reviewer, betaTask, { title: 'renamed' })
    ).rejects.toThrow(WorkError);
    await expect(addWorkComment(tenantId, u.idle, betaTask, 'hello')).rejects.toThrow(WorkError);
    await expect(deleteWorkItem(tenantId, u.admin, betaTask)).rejects.toThrow(
      'That task is not in this workspace.'
    );
    await expect(createSprint(tenantId, u.admin, beta, { name: 'S1' })).rejects.toThrow(WorkError);
    await expect(postProjectMessage(tenantId, u.reviewer, beta, 'hi')).rejects.toThrow(
      /not in this workspace/
    );
    // Another workspace's owner gets the same answer for this workspace's task.
    await expect(
      updateWorkItem(otherTenant, u.outsider, alphaTask, { title: 'x' })
    ).rejects.toThrow(WorkError);
  });

  it('keeps reviewer vs admin rules inside a project they are in', async () => {
    await expect(deleteWorkItem(tenantId, u.reviewer, alphaTask)).rejects.toThrow(
      /Only owners and admins/
    );
    const scratch = await createWorkItem(tenantId, u.reviewer, alpha, { title: 'scratch' });
    await deleteWorkItem(tenantId, u.admin, scratch.id);
  });

  it('only lets a task be assigned to someone who can see the project', async () => {
    await expect(
      updateWorkItem(tenantId, u.admin, alphaTask, { title: 'alpha task', assigneeId: u.other })
    ).rejects.toThrow(/member of this project/);
    await updateWorkItem(tenantId, u.admin, alphaTask, {
      title: 'alpha task',
      assigneeId: u.reviewer,
    });
    const people = (await listProjectPeople(tenantId, alpha)).map((p) => p.user_id).sort();
    expect(people).toEqual([u.owner, u.admin, u.reviewer].sort());
  });

  it('keeps tenant-wide reads to the given projects', async () => {
    const hits = await searchWorkItems(tenantId, 'secret', 30, [alpha]);
    expect(hits).toEqual([]);
    expect((await searchWorkItems(tenantId, 'secret', 30, null)).length).toBe(1);
    const events = await listWorkEvents(tenantId, { projectIds: [alpha] }, 100);
    expect(events.every((e) => e.project_id === alpha)).toBe(true);
    // An empty scope (a member of no project) sees nothing, not everything.
    expect(await listWorkEvents(tenantId, { projectIds: [] }, 100)).toEqual([]);
    const breakdown = await flagBreakdown(tenantId, []);
    expect(breakdown.openByCategory).toEqual([]);
  });

  it('enforces who may add, promote, demote and remove project members', async () => {
    // A reviewer changes nobody, not even themselves.
    await expect(
      setProjectMember(tenantId, u.reviewer, { projectId: alpha, userId: u.idle, role: 'reviewer' })
    ).rejects.toThrow(ProjectAccessError);
    await expect(
      setProjectMember(tenantId, u.reviewer, {
        projectId: alpha,
        userId: u.reviewer,
        role: 'admin',
      })
    ).rejects.toThrow(/your own role/);
    // An admin cannot add an admin directly, nor touch a project they are not in.
    await expect(
      setProjectMember(tenantId, u.admin, { projectId: alpha, userId: u.idle, role: 'admin' })
    ).rejects.toThrow(/Project admins can/);
    await expect(
      setProjectMember(tenantId, u.admin, { projectId: beta, userId: u.idle, role: 'reviewer' })
    ).rejects.toThrow('That project is not in this workspace.');
    // Nobody adds an owner (they see everything) or a stranger.
    await expect(
      setProjectMember(tenantId, u.admin, { projectId: alpha, userId: u.owner, role: 'reviewer' })
    ).rejects.toThrow(/Owners already/);
    await expect(
      setProjectMember(tenantId, u.owner, {
        projectId: alpha,
        userId: u.outsider,
        role: 'reviewer',
      })
    ).rejects.toThrow(/not on the team/);
    // Another workspace's owner cannot reach this project at all.
    await expect(
      setProjectMember(otherTenant, u.outsider, {
        projectId: alpha,
        userId: u.outsider,
        role: 'admin',
      })
    ).rejects.toThrow(ProjectAccessError);
    // A forged role or id is refused before any query.
    await expect(
      setProjectMember(tenantId, u.owner, {
        projectId: alpha,
        userId: u.idle,
        role: 'owner' as never,
      })
    ).rejects.toThrow(/admin or reviewer/);
    await expect(
      setProjectMember(tenantId, u.owner, { projectId: "x' or 1=1", userId: u.idle, role: null })
    ).rejects.toThrow(ProjectAccessError);

    // The admin adds idle as a reviewer, promotes them, and then cannot demote that new admin.
    await setProjectMember(tenantId, u.admin, {
      projectId: alpha,
      userId: u.idle,
      role: 'reviewer',
    });
    await setProjectMember(tenantId, u.admin, { projectId: alpha, userId: u.idle, role: 'admin' });
    await expect(
      setProjectMember(tenantId, u.admin, { projectId: alpha, userId: u.idle, role: null })
    ).rejects.toThrow(ProjectAccessError);
    // The owner can.
    await setProjectMember(tenantId, u.owner, { projectId: alpha, userId: u.idle, role: null });
    expect((await listProjectMembers(tenantId, alpha)).map((m) => m.user_id)).not.toContain(u.idle);
  });

  it('adds a person exactly once when the same add is sent in parallel', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        setProjectMember(tenantId, u.owner, { projectId: beta, userId: u.idle, role: 'reviewer' })
      )
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const [{ n } = { n: 0 }] = await query<{ n: number }>(
      `select count(*)::int as n from project_members where project_id = $1 and user_id = $2`,
      [beta, u.idle]
    );
    expect(n).toBe(1);
    await setProjectMember(tenantId, u.owner, { projectId: beta, userId: u.idle, role: null });
  });

  it('drops a removed workspace member from every project', async () => {
    const [row] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-leaver@example.test`]
    );
    await addMembership(tenantId, row!.id, 'reviewer');
    await setProjectMember(tenantId, u.owner, {
      projectId: alpha,
      userId: row!.id,
      role: 'reviewer',
    });
    await query(`delete from memberships where tenant_id = $1 and user_id = $2`, [
      tenantId,
      row!.id,
    ]);
    expect(await listVisibleProjects(tenantId, row!.id)).toEqual([]);
  });

  it('logs time only on a visible task, and only the author deletes an entry', async () => {
    await logTime(tenantId, u.reviewer, alphaTask, {
      minutes: 90,
      spentOn: new Date().toISOString().slice(0, 10),
      note: 'reviewed <script>alert(1)</script>',
    });
    await expect(
      logTime(tenantId, u.reviewer, betaTask, {
        minutes: 30,
        spentOn: new Date().toISOString().slice(0, 10),
      })
    ).rejects.toThrow('That task is not in this workspace.');
    await expect(
      logTime(otherTenant, u.outsider, alphaTask, {
        minutes: 30,
        spentOn: new Date().toISOString().slice(0, 10),
      })
    ).rejects.toThrow(ProjectAccessError);

    const [entry] = await listTimeEntries(tenantId, alphaTask);
    expect(entry?.minutes).toBe(90);
    // Stored as text; React escapes it on the page.
    expect(entry?.note).toContain('<script>');
    await expect(deleteTimeEntry(tenantId, u.admin, entry!.id)).rejects.toThrow(/not found/);
    await expect(deleteTimeEntry(otherTenant, u.reviewer, entry!.id)).rejects.toThrow(/not found/);

    const tracking = await projectTracking(tenantId, alpha);
    const reviewer = tracking.find((r) => r.user_id === u.reviewer);
    expect(reviewer).toMatchObject({ role: 'reviewer', assigned: 1, minutes: 90 });
    expect(reviewer?.last_active).toBeInstanceOf(Date);
    expect(tracking.find((r) => r.user_id === u.admin)?.role).toBe('admin');

    await deleteTimeEntry(tenantId, u.reviewer, entry!.id);
    expect(await listTimeEntries(tenantId, alphaTask)).toEqual([]);
  });

  it('shows one person’s activity in a project', async () => {
    const mine = await listWorkEvents(tenantId, { projectId: alpha, actorId: u.admin }, 50);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.project_id === alpha)).toBe(true);
    expect(await listWorkEvents(tenantId, { actorId: 'nope' }, 50)).toEqual([]);
  });
});
