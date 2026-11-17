/**
 * Project charts and task notifications: the burndown arithmetic (pure), and against the test
 * database weekly throughput, the burndown of a live sprint, and who hears about task events.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMembership,
  addWorkComment,
  burndownSeries,
  closePool,
  createProject,
  createSprint,
  createTenant,
  createWorkItem,
  dayRange,
  digestContent,
  moveWorkItem,
  query,
  setWorkItemSprint,
  sprintBurndown,
  startSprint,
  updateWorkItem,
  weeklyThroughput,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('burndown arithmetic', () => {
  it('lists each day inclusive, capped', () => {
    expect(dayRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(dayRange('2026-11-02', '2026-11-01')).toEqual([]);
    expect(dayRange('2026-01-01', '2026-12-31', 5)).toHaveLength(5);
  });

  it('counts a task open until the day it reached Done, and open again if reopened', () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
    const tasks = [
      { status: 'done' as const, changes: [{ day: '2026-11-02', from: 'todo', to: 'done' }] },
      {
        status: 'in_progress' as const,
        changes: [
          { day: '2026-11-01', from: 'todo', to: 'done' },
          { day: '2026-11-03', from: 'done', to: 'in_progress' },
        ],
      },
      { status: 'todo' as const, changes: [] },
    ];
    expect(burndownSeries(tasks, days)).toEqual([2, 1, 2, 2]);
    expect(burndownSeries([], days)).toEqual([0, 0, 0, 0]);
  });

  it('burns story points, counting an unestimated task as 0', () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
    const tasks = [
      {
        status: 'done' as const,
        points: 5,
        changes: [{ day: '2026-11-02', from: 'todo', to: 'done' }],
      },
      { status: 'todo' as const, points: 3, changes: [] },
      { status: 'todo' as const, points: null, changes: [] },
    ];
    expect(burndownSeries(tasks, days, 'points')).toEqual([8, 3, 3]);
    expect(burndownSeries(tasks, days)).toEqual([3, 2, 2]);
  });
});

describe.skipIf(!hasDatabase)('charts and task notifications in the database', () => {
  const label = `charts-${Date.now()}`;
  let tenantId: string;
  let projectId: string;
  const users: Record<'owner' | 'dev' | 'qa' | 'outsider', string> = {} as never;

  const inbox = async (userId: string) =>
    query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind, payload from notifications where tenant_id = $1 and user_id = $2
       order by created_at`,
      [tenantId, userId]
    );

  beforeAll(async () => {
    tenantId = (await createTenant(label)).id;
    for (const key of Object.keys({ owner: 1, dev: 1, qa: 1, outsider: 1 })) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      users[key as keyof typeof users] = user!.id;
    }
    await addMembership(tenantId, users.owner, 'owner');
    await addMembership(tenantId, users.dev, 'reviewer');
    await addMembership(tenantId, users.qa, 'reviewer');
    projectId = (
      await createProject(tenantId, { name: 'Charts', sourceType: 'file' }, { unlimited: true })
    ).id;
  });

  it('counts tasks created and completed this week', async () => {
    const a = await createWorkItem(tenantId, users.owner, projectId, { title: 'A' });
    await createWorkItem(tenantId, users.owner, projectId, { title: 'B' });
    await moveWorkItem(tenantId, users.owner, a.id, { status: 'done' });
    const weeks = await weeklyThroughput(tenantId, projectId, 12);
    expect(weeks).toHaveLength(12);
    expect(weeks.at(-1)).toMatchObject({ created: 2, completed: 1 });
    expect(weeks.slice(0, -1).every((w) => w.created === 0 && w.completed === 0)).toBe(true);
    expect(await weeklyThroughput(tenantId, 'nope')).toEqual([]);
  });

  it('draws the burndown of a running sprint', async () => {
    const sprint = (await createSprint(tenantId, users.owner, projectId, { name: 'S1' })).id;
    const x = await createWorkItem(tenantId, users.owner, projectId, {
      title: 'X',
      storyPoints: '5',
    });
    const y = await createWorkItem(tenantId, users.owner, projectId, {
      title: 'Y',
      storyPoints: '3',
    });
    await setWorkItemSprint(tenantId, users.owner, x.id, sprint);
    await setWorkItemSprint(tenantId, users.owner, y.id, sprint);
    expect(await sprintBurndown(tenantId, sprint)).toBeNull();
    await startSprint(tenantId, users.owner, sprint);
    await moveWorkItem(tenantId, users.owner, x.id, { status: 'done' });
    const burn = await sprintBurndown(tenantId, sprint);
    expect(burn).toMatchObject({
      total: 2,
      remaining: [1],
      totalPoints: 8,
      remainingPoints: [3],
    });
    expect(burn?.days).toHaveLength(1);
  });

  it('tells the new assignee, never the person who assigned', async () => {
    const own = await createWorkItem(tenantId, users.dev, projectId, {
      title: 'Self-assigned',
      assigneeId: users.dev,
    });
    expect(await inbox(users.dev)).toEqual([]);

    const task = await createWorkItem(tenantId, users.owner, projectId, {
      title: 'Fix login',
      assigneeId: users.dev,
    });
    const [note] = await inbox(users.dev);
    expect(note).toMatchObject({
      kind: 'task_assigned',
      payload: {
        taskId: task.id,
        projectId,
        number: task.number,
        key: task.key,
        title: 'Fix login',
        by: `${label}-owner@example.test`,
      },
    });

    // Reassigning tells the new person only; an unchanged assignee tells nobody.
    await updateWorkItem(tenantId, users.owner, task.id, {
      title: 'Fix login',
      assigneeId: users.qa,
    });
    await updateWorkItem(tenantId, users.owner, task.id, {
      title: 'Fix login!',
      assigneeId: users.qa,
    });
    expect((await inbox(users.qa)).map((n) => n.kind)).toEqual(['task_assigned']);
    expect(await inbox(users.dev)).toHaveLength(1);
    expect(own.number).toBeGreaterThan(0);
  });

  it('tells the assignee and reporter about a comment, not the commenter or outsiders', async () => {
    const task = await createWorkItem(tenantId, users.owner, projectId, {
      title: 'Discuss',
      assigneeId: users.qa,
    });
    const before = (await inbox(users.qa)).length;
    await addWorkComment(tenantId, users.dev, task.id, 'Looks off by one');
    expect((await inbox(users.qa)).length).toBe(before + 1);
    expect((await inbox(users.owner)).at(-1)?.kind).toBe('task_commented');
    expect((await inbox(users.dev)).some((n) => n.kind === 'task_commented')).toBe(false);
    expect(await inbox(users.outsider)).toEqual([]);
  });

  it('lists overdue tasks in the assignee digest only', async () => {
    await createWorkItem(tenantId, users.owner, projectId, {
      title: 'Late one',
      assigneeId: users.qa,
      dueOn: '2020-01-01',
    });
    const qa = await digestContent(tenantId, users.qa);
    expect(qa.overdue.map((o) => o.title)).toEqual(['Late one']);
    expect((await digestContent(tenantId, users.dev)).overdue).toEqual([]);
  });
});
