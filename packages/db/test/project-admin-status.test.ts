/**
 * Naming a project's admin when it is created, and the owner-only project status.
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProjectAdminError,
  WorkError,
  addMembership,
  closePool,
  createProject,
  createTenant,
  getProjectDetail,
  listVisibleProjects,
  projectRole,
  query,
  setProjectStatus,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('project admin at creation and project status', () => {
  const label = `pa${Date.now()}`;
  type Who = 'owner' | 'admin' | 'reviewer' | 'otherOwner';
  const u = {} as Record<Who, string>;
  let team: string;
  let otherTeam: string;

  beforeAll(async () => {
    team = (await createTenant(`${label} team`)).id;
    otherTeam = (await createTenant(`${label} other`)).id;
    for (const key of ['owner', 'admin', 'reviewer', 'otherOwner'] as const) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      u[key] = row!.id;
    }
    await addMembership(team, u.owner, 'owner');
    await addMembership(team, u.admin, 'admin');
    await addMembership(team, u.reviewer, 'reviewer');
    await addMembership(otherTeam, u.otherOwner, 'owner');
  });

  const count = async () =>
    Number(
      (
        await query<{ n: string }>(`select count(*) n from projects where tenant_id = $1`, [team])
      )[0]!.n
    );

  it('makes the chosen member the new project admin, and nobody else a member', async () => {
    const project = await createProject(
      team,
      { name: 'With admin', sourceType: 'file' },
      { unlimited: true, adminId: u.reviewer, addedBy: u.owner }
    );
    expect(await projectRole(team, project.id, u.reviewer)).toBe('admin');
    expect(await listVisibleProjects(team, u.reviewer)).toHaveLength(1);
    expect(await projectRole(team, project.id, u.admin)).toBeNull();
    const [row] = await query<{ added_by: string }>(
      `select added_by from project_members where project_id = $1`,
      [project.id]
    );
    expect(row?.added_by).toBe(u.owner);
  });

  it('works without an admin, as before', async () => {
    const project = await createProject(
      team,
      { name: 'No admin', sourceType: 'file' },
      { unlimited: true }
    );
    expect(
      await query(`select 1 from project_members where project_id = $1`, [project.id])
    ).toEqual([]);
  });

  it("refuses an owner, a stranger, another workspace's member and junk, leaving no project", async () => {
    const before = await count();
    for (const adminId of [
      u.owner,
      u.otherOwner,
      '00000000-0000-4000-8000-000000000000',
      "x' or 1=1",
      'nope',
    ]) {
      await expect(
        createProject(team, { name: 'Refused', sourceType: 'file' }, { unlimited: true, adminId })
      ).rejects.toThrow(ProjectAdminError);
    }
    expect(await count()).toBe(before);
  });

  it("lets only an owner of the project's workspace change its status, and back again", async () => {
    const project = await createProject(
      team,
      { name: 'Status', sourceType: 'file' },
      { unlimited: true, adminId: u.admin }
    );
    expect((await getProjectDetail(team, project.id))?.status).toBe('active');

    // The project's own admin may not; a person outside the project cannot even see it.
    await expect(setProjectStatus(team, u.admin, project.id, 'completed')).rejects.toThrow(
      /Only owners/
    );
    await expect(setProjectStatus(team, u.reviewer, project.id, 'completed')).rejects.toThrow(
      /not in this workspace/
    );
    await expect(
      setProjectStatus(otherTeam, u.otherOwner, project.id, 'completed')
    ).rejects.toThrow(WorkError);
    await expect(setProjectStatus(team, u.owner, project.id, 'finished')).rejects.toThrow(
      /Choose a project status/
    );
    await expect(setProjectStatus(team, u.owner, 'nope', 'completed')).rejects.toThrow(WorkError);
    expect((await getProjectDetail(team, project.id))?.status).toBe('active');

    await setProjectStatus(team, u.owner, project.id, 'completed');
    expect((await getProjectDetail(team, project.id))?.status).toBe('completed');
    await setProjectStatus(team, u.owner, project.id, 'active');
    expect((await getProjectDetail(team, project.id))?.status).toBe('active');
  });
});
