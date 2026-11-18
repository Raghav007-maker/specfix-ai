/**
 * Team search, join requests and project requests: who may ask, who may decide, and that a
 * decision happens exactly once. Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RequestError,
  addMembership,
  canRequestProject,
  closePool,
  createProject,
  createTenant,
  decideJoinRequest,
  decideProjectRequest,
  listJoinRequests,
  listMyJoinRequests,
  listProjectRequests,
  listVisibleProjects,
  projectRole,
  query,
  requestProject,
  requestToJoin,
  searchTeams,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('team requests', () => {
  const label = `tr${Date.now()}`;
  type Who = 'owner' | 'admin' | 'reviewer' | 'newbie' | 'other';
  const u = {} as Record<Who, string>;
  let team: string;
  let otherTeam: string;

  beforeAll(async () => {
    team = (await createTenant(`${label} Acme Robotics`)).id;
    otherTeam = (await createTenant(`${label} Other Org`)).id;
    for (const key of ['owner', 'admin', 'reviewer', 'newbie', 'other'] as const) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      u[key] = row!.id;
    }
    await addMembership(team, u.owner, 'owner');
    await addMembership(team, u.admin, 'admin');
    await addMembership(team, u.reviewer, 'reviewer');
    await addMembership(otherTeam, u.other, 'owner');
    // Everyone owns a personal workspace in real life; the newbie's is another tenant.
    await addMembership((await createTenant(`${label} newbie home`)).id, u.newbie, 'owner');
  });

  it('finds a team by part of its name, never one the person is already in', async () => {
    expect((await searchTeams(u.newbie, `${label} acme`)).map((t) => t.name)).toEqual([
      `${label} Acme Robotics`,
    ]);
    expect(await searchTeams(u.owner, `${label} acme`)).toEqual([]);
  });

  it('treats the search text as a literal and needs 3 characters', async () => {
    expect(await searchTeams(u.newbie, 'ac')).toEqual([]);
    expect(await searchTeams(u.newbie, '%%%')).toEqual([]);
    expect(await searchTeams(u.newbie, '___')).toEqual([]);
    expect(await searchTeams(u.newbie, "x' or 1=1 --")).toEqual([]);
    expect(await searchTeams('not-a-uuid', 'acme')).toEqual([]);
  });

  it('refuses a member, a missing team, a forged id and a second pending request', async () => {
    await expect(requestToJoin(u.reviewer, team)).rejects.toThrow(/already in/);
    await expect(requestToJoin(u.newbie, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      RequestError
    );
    await expect(requestToJoin(u.newbie, "x' or 1=1")).rejects.toThrow(RequestError);

    await requestToJoin(u.newbie, team);
    await expect(requestToJoin(u.newbie, team)).rejects.toThrow(/already asked/);
    expect((await listMyJoinRequests(u.newbie))[0]).toMatchObject({ status: 'pending' });
    expect((await searchTeams(u.newbie, `${label} acme`))[0]?.requested).toBe(true);
  });

  it('shows pending requests only to an owner', async () => {
    expect((await listJoinRequests(team, u.owner)).map((r) => r.user_id)).toEqual([u.newbie]);
    expect(await listJoinRequests(team, u.admin)).toEqual([]);
    expect(await listJoinRequests(team, u.reviewer)).toEqual([]);
    expect(await listJoinRequests(team, u.other)).toEqual([]);
  });

  it('lets only the owner decide, and not across workspaces', async () => {
    const [request] = await listJoinRequests(team, u.owner);
    for (const who of [u.admin, u.reviewer, u.newbie, u.other]) {
      await expect(decideJoinRequest(team, who, request!.id, true)).rejects.toThrow(
        'That request was not found.'
      );
    }
    // Another workspace's owner, using the right request id with their own tenant id.
    await expect(decideJoinRequest(otherTeam, u.other, request!.id, true)).rejects.toThrow(
      RequestError
    );
    await expect(decideJoinRequest(team, u.owner, 'nope', true)).rejects.toThrow(RequestError);
  });

  it('admits the person once as a reviewer, in no project, however many clicks', async () => {
    const [request] = await listJoinRequests(team, u.owner);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => decideJoinRequest(team, u.owner, request!.id, true))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await query<{ role: string }>(
      `select role from memberships where tenant_id = $1 and user_id = $2`,
      [team, u.newbie]
    );
    expect(rows).toEqual([{ role: 'reviewer' }]);
    expect(await listVisibleProjects(team, u.newbie)).toEqual([]);
  });

  it('a rejected request admits nobody and can be asked again', async () => {
    await requestToJoin(u.other, team);
    const [request] = await listJoinRequests(team, u.owner);
    await decideJoinRequest(team, u.owner, request!.id, false);
    expect(
      await query(`select 1 from memberships where tenant_id = $1 and user_id = $2`, [
        team,
        u.other,
      ])
    ).toEqual([]);
    await requestToJoin(u.other, team);
  });

  it('lets only admins ask for a project, and caps open requests at 3', async () => {
    expect(await canRequestProject(team, u.admin)).toBe(true);
    expect(await canRequestProject(team, u.owner)).toBe(false);
    expect(await canRequestProject(team, u.reviewer)).toBe(false);
    for (const who of [u.owner, u.reviewer, u.other]) {
      await expect(requestProject(team, who, 'Sneaky')).rejects.toThrow(/Only admins/);
    }
    await expect(requestProject(team, u.admin, '   ')).rejects.toThrow(/required/);
    await expect(requestProject(team, u.admin, 'x'.repeat(101))).rejects.toThrow(/100/);

    // Parallel requests cannot slip past the cap.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => requestProject(team, u.admin, `Cap ${i}`))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });

  it('shows the owner every request and an admin only their own', async () => {
    expect((await listProjectRequests(team, u.owner)).length).toBe(3);
    expect((await listProjectRequests(team, u.admin)).length).toBe(3);
    expect(await listProjectRequests(team, u.reviewer)).toEqual([]);
    expect(await listProjectRequests(team, u.other)).toEqual([]);
  });

  it('creates the project once on approval and makes the requester its admin', async () => {
    const [request] = await listProjectRequests(team, u.owner);
    await expect(decideProjectRequest(team, u.admin, request!.id, true)).rejects.toThrow(
      'That request was not found.'
    );
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        decideProjectRequest(team, u.owner, request!.id, true, { unlimited: true })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const created = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      projectId: string | null;
    }>;
    expect(await projectRole(team, created.value.projectId!, u.admin)).toBe('admin');
    expect(
      await query(`select 1 from projects where tenant_id = $1 and name = $2`, [
        team,
        request!.name,
      ])
    ).toHaveLength(1);
  });

  it('a rejected project request creates nothing; a requester who left blocks approval', async () => {
    const [pending] = (await listProjectRequests(team, u.owner)).filter(
      (r) => r.status === 'pending'
    );
    await decideProjectRequest(team, u.owner, pending!.id, false);
    expect(
      await query(`select 1 from projects where tenant_id = $1 and name = $2`, [
        team,
        pending!.name,
      ])
    ).toEqual([]);

    const [last] = (await listProjectRequests(team, u.owner)).filter((r) => r.status === 'pending');
    await query(`delete from memberships where tenant_id = $1 and user_id = $2`, [team, u.admin]);
    await expect(decideProjectRequest(team, u.owner, last!.id, true)).rejects.toThrow(/no longer/);
    expect(await createProject(team, { name: 'control', sourceType: 'file' })).toBeTruthy();
  });
});
