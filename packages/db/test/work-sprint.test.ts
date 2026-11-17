/**
 * Sprints: the input rules, and against the test database who may plan them, one active
 * sprint per project (also under a race), moving tasks between backlog and sprints, and
 * completion sending unfinished work back to the backlog.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WorkError,
  addMembership,
  closePool,
  completeSprint,
  createProject,
  createSprint,
  createTenant,
  createWorkItem,
  getWorkItemByNumber,
  listSprints,
  listWorkEvents,
  moveWorkItem,
  normalizeSprintInput,
  query,
  setWorkItemSprint,
  sprintCountRows,
  startSprint,
  summarizeCounts,
  updateSprint,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('sprint input rules', () => {
  it('validates name, goal and date order', () => {
    expect(
      normalizeSprintInput({
        name: '  Sprint   1 ',
        goal: ' ship ',
        startsOn: '2026-11-02',
        endsOn: '',
      })
    ).toEqual({ name: 'Sprint 1', goal: 'ship', startsOn: '2026-11-02', endsOn: null });
    expect(() => normalizeSprintInput({ name: ' ' })).toThrow(/needs a name/);
    expect(() => normalizeSprintInput({ name: 'x'.repeat(101) })).toThrow(/100/);
    expect(() => normalizeSprintInput({ name: 's', goal: 'g'.repeat(1001) })).toThrow(WorkError);
    expect(() =>
      normalizeSprintInput({ name: 's', startsOn: '2026-11-10', endsOn: '2026-11-09' })
    ).toThrow(/end before it starts/);
    expect(() => normalizeSprintInput({ name: 's', endsOn: '2026-13-01' })).toThrow(/end date/);
  });
});

describe.skipIf(!hasDatabase)('sprints in the database', () => {
  const label = `sprint-${Date.now()}`;
  let tenantA: string;
  let tenantB: string;
  let projectP: string;
  let projectQ: string;
  let projectB: string;
  const users: Record<'owner' | 'admin' | 'rev' | 'otherOwner', string> = {} as never;
  const sprint: Record<string, string> = {};

  beforeAll(async () => {
    tenantA = (await createTenant(`${label}-a`)).id;
    tenantB = (await createTenant(`${label}-b`)).id;
    for (const key of Object.keys({ owner: 1, admin: 1, rev: 1, otherOwner: 1 })) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      users[key as keyof typeof users] = user!.id;
    }
    await addMembership(tenantA, users.owner, 'owner');
    await addMembership(tenantA, users.admin, 'admin');
    await addMembership(tenantA, users.rev, 'reviewer');
    await addMembership(tenantB, users.otherOwner, 'owner');
    const opts = { unlimited: true };
    projectP = (await createProject(tenantA, { name: 'Plan', sourceType: 'file' }, opts)).id;
    projectQ = (await createProject(tenantA, { name: 'Quick', sourceType: 'file' }, opts)).id;
    projectB = (await createProject(tenantB, { name: 'Bee', sourceType: 'file' }, opts)).id;
  });

  it('lets only owners and admins create and edit sprints', async () => {
    sprint.one = (await createSprint(tenantA, users.admin, projectP, { name: 'One' })).id;
    sprint.two = (await createSprint(tenantA, users.owner, projectP, { name: 'Two' })).id;
    sprint.other = (await createSprint(tenantA, users.owner, projectQ, { name: 'Elsewhere' })).id;
    sprint.remote = (
      await createSprint(tenantB, users.otherOwner, projectB, { name: 'Remote' })
    ).id;

    await expect(createSprint(tenantA, users.rev, projectP, { name: 'No' })).rejects.toThrow(
      /owners and admins/
    );
    await expect(createSprint(tenantA, users.owner, projectB, { name: 'No' })).rejects.toThrow(
      /not in this workspace/
    );
    await expect(
      updateSprint(tenantB, users.otherOwner, sprint.one!, { name: 'Hijack' })
    ).rejects.toThrow(/not in this workspace/);
    await expect(updateSprint(tenantA, users.rev, sprint.one!, { name: 'No' })).rejects.toThrow(
      /owners and admins/
    );
    await updateSprint(tenantA, users.admin, sprint.one!, {
      name: 'Sprint one',
      goal: 'Checkout',
      startsOn: '2026-11-02',
      endsOn: '2026-11-13',
    });
    const [first] = await listSprints(tenantA, projectP);
    expect(first).toMatchObject({ name: 'Sprint one', goal: 'Checkout', ends_on: '2026-11-13' });
    expect(await listSprints(tenantB, projectP)).toEqual([]);
  });

  it('lets any member move tasks between the backlog and an open sprint of the project', async () => {
    const a = await createWorkItem(tenantA, users.rev, projectP, { title: 'A', status: 'done' });
    const b = await createWorkItem(tenantA, users.rev, projectP, {
      title: 'B',
      status: 'in_progress',
    });
    const c = await createWorkItem(tenantA, users.rev, projectP, { title: 'C' });
    for (const task of [a, b, c]) {
      expect(await setWorkItemSprint(tenantA, users.rev, task.id, sprint.one!)).toMatchObject({
        changed: true,
      });
    }
    expect((await setWorkItemSprint(tenantA, users.rev, a.id, sprint.one!)).changed).toBe(false);
    expect((await getWorkItemByNumber(tenantA, projectP, a.number))?.sprint_name).toBe(
      'Sprint one'
    );
    const [event] = await listWorkEvents(tenantA, { workItemId: c.id });
    expect(event).toMatchObject({ field: 'sprint', from_value: 'Backlog', to_value: 'Sprint one' });

    for (const bad of [sprint.other!, sprint.remote!, 'nope']) {
      await expect(setWorkItemSprint(tenantA, users.rev, c.id, bad)).rejects.toThrow(WorkError);
    }
    await expect(setWorkItemSprint(tenantB, users.otherOwner, c.id, null)).rejects.toThrow(
      /not in this workspace/
    );
    const counts = summarizeCounts(
      (await sprintCountRows(tenantA, projectP)).filter((r) => r.sprint_id === sprint.one)
    );
    expect(counts).toMatchObject({ total: 3, percentDone: 33 });
    expect(await sprintCountRows(tenantB, projectP)).toEqual([]);
  });

  it('keeps one active sprint per project', async () => {
    await expect(startSprint(tenantA, users.rev, sprint.one!)).rejects.toThrow(/owners and admins/);
    await startSprint(tenantA, users.admin, sprint.one!);
    await expect(startSprint(tenantA, users.admin, sprint.one!)).rejects.toThrow(/planned sprint/);
    await expect(startSprint(tenantA, users.admin, sprint.two!)).rejects.toThrow(
      /already has an active/
    );
    // Another project is unaffected.
    await startSprint(tenantA, users.admin, sprint.other!);

    const statuses = (await listSprints(tenantA, projectP)).map((s) => [s.name, s.status]);
    expect(statuses).toEqual([
      ['Sprint one', 'active'],
      ['Two', 'planned'],
    ]);
  });

  it('lets exactly one of two simultaneous starts win', async () => {
    const project = (
      await createProject(tenantA, { name: 'Race', sourceType: 'file' }, { unlimited: true })
    ).id;
    const x = (await createSprint(tenantA, users.owner, project, { name: 'X' })).id;
    const y = (await createSprint(tenantA, users.owner, project, { name: 'Y' })).id;
    const results = await Promise.allSettled([
      startSprint(tenantA, users.owner, x),
      startSprint(tenantA, users.admin, y),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(WorkError);
    expect((await listSprints(tenantA, project)).filter((s) => s.status === 'active')).toHaveLength(
      1
    );
  });

  it('completes a sprint: unfinished work returns to the backlog, done work stays', async () => {
    await expect(completeSprint(tenantA, users.rev, sprint.one!)).rejects.toThrow(
      /owners and admins/
    );
    await expect(completeSprint(tenantA, users.owner, sprint.two!)).rejects.toThrow(
      /active sprint/
    );
    await expect(completeSprint(tenantB, users.otherOwner, sprint.one!)).rejects.toThrow(
      /not in this workspace/
    );

    expect(await completeSprint(tenantA, users.owner, sprint.one!)).toEqual({
      done: 1,
      returned: 2,
    });
    const rows = await query<{ title: string; sprint_id: string | null }>(
      `select title, sprint_id from work_items where tenant_id = $1 and project_id = $2 order by number`,
      [tenantA, projectP]
    );
    expect(rows).toEqual([
      { title: 'A', sprint_id: sprint.one },
      { title: 'B', sprint_id: null },
      { title: 'C', sprint_id: null },
    ]);
    const [b] = await query<{ id: string }>(
      `select id from work_items where tenant_id = $1 and project_id = $2 and title = 'B'`,
      [tenantA, projectP]
    );
    const [event] = await listWorkEvents(tenantA, { workItemId: b!.id });
    expect(event).toMatchObject({ field: 'sprint', from_value: 'Sprint one', to_value: 'Backlog' });
    const projectEvents = await listWorkEvents(tenantA, { projectId: projectP }, 100);
    expect(projectEvents.find((e) => e.kind === 'sprint_completed')?.to_value).toBe(
      '1 done, 2 back to the backlog'
    );

    // A completed sprint is a record: it cannot be restarted, edited, completed or added to.
    await expect(startSprint(tenantA, users.owner, sprint.one!)).rejects.toThrow(WorkError);
    await expect(
      updateSprint(tenantA, users.owner, sprint.one!, { name: 'Again' })
    ).rejects.toThrow(/completed sprint/);
    await expect(completeSprint(tenantA, users.owner, sprint.one!)).rejects.toThrow(WorkError);
    await expect(setWorkItemSprint(tenantA, users.rev, b!.id, sprint.one!)).rejects.toThrow(
      /completed sprint/
    );
    // Moving a done task does not pull it out of its completed sprint.
    const [a] = await query<{ id: string }>(
      `select id from work_items where tenant_id = $1 and project_id = $2 and title = 'A'`,
      [tenantA, projectP]
    );
    await moveWorkItem(tenantA, users.rev, a!.id, { status: 'done' });
    // The next sprint can start now.
    await startSprint(tenantA, users.owner, sprint.two!);
  });
});
