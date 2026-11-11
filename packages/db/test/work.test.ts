/**
 * Project work tracking: the pure input rules, and against the test database the
 * permission, tenant-isolation and numbering rules of packages/db/src/repositories/work.ts.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL, like the other
 * fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WorkError,
  addMembership,
  closePool,
  createProject,
  createTenant,
  createWorkItem,
  deleteWorkItem,
  deriveTaskKey,
  diffTask,
  getProjectDetail,
  getWorkItemByNumber,
  listWorkEvents,
  listWorkItems,
  normalizeTaskInput,
  normalizeTaskKey,
  parseDueDate,
  parseTagList,
  query,
  summarizeCounts,
  taskKeyOf,
  updateProjectDetails,
  updateWorkItem,
  workCountRows,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('task input rules', () => {
  it('derives a task key from a project name', () => {
    expect(deriveTaskKey('Checkout Flow')).toBe('CF');
    expect(deriveTaskKey('Payments')).toBe('PAY');
    expect(deriveTaskKey('mobile app v2 rewrite now')).toBe('MAVR');
    expect(deriveTaskKey('2024 roadmap')).toBe('TASK');
    expect(deriveTaskKey('!!!')).toBe('TASK');
    expect(deriveTaskKey('x')).toBe('TASK');
    expect(taskKeyOf('CF', 12)).toBe('CF-12');
    expect(taskKeyOf(null, 3)).toBe('TASK-3');
  });

  it('accepts only a well-formed typed key', () => {
    expect(normalizeTaskKey(' spx ')).toBe('SPX');
    for (const bad of ['S', '1AB', 'AB-C', 'ABCDEFGHIJK', "A'; drop"]) {
      expect(() => normalizeTaskKey(bad)).toThrow(WorkError);
    }
  });

  it('parses labels: trimmed, de-duplicated ignoring case, bounded', () => {
    expect(parseTagList(' ui, Login ,UI,, login ')).toEqual(['ui', 'Login']);
    expect(parseTagList('')).toEqual([]);
    expect(parseTagList(null)).toEqual([]);
    expect(() => parseTagList('x'.repeat(41))).toThrow(WorkError);
    expect(() => parseTagList(Array.from({ length: 21 }, (_, i) => `t${i}`).join(','))).toThrow(
      /at most 20/
    );
  });

  it('accepts only real calendar dates', () => {
    expect(parseDueDate('2026-11-30')).toBe('2026-11-30');
    expect(parseDueDate(' ')).toBeNull();
    for (const bad of ['2026-02-30', '30/11/2026', '2026-11-30T00:00', '1999-01-01', 'tomorrow']) {
      expect(() => parseDueDate(bad)).toThrow(WorkError);
    }
  });

  it('validates a whole task form, with defaults', () => {
    expect(normalizeTaskInput({ title: '  Fix   login ' })).toEqual({
      title: 'Fix login',
      description: '',
      type: 'task',
      priority: 'medium',
      status: 'todo',
      assigneeId: null,
      dueOn: null,
      labels: [],
      components: [],
      ticketId: null,
      scenarioId: null,
    });
    expect(() => normalizeTaskInput({ title: ' ' })).toThrow(/needs a title/);
    expect(() => normalizeTaskInput({ title: 'x'.repeat(201) })).toThrow(/200/);
    expect(() => normalizeTaskInput({ title: 't', description: 'x'.repeat(20001) })).toThrow();
    expect(() => normalizeTaskInput({ title: 't', type: 'incident' })).toThrow(WorkError);
    expect(() => normalizeTaskInput({ title: 't', status: "done' or 1=1" })).toThrow(WorkError);
    expect(() => normalizeTaskInput({ title: 't', assigneeId: 'not-a-uuid' })).toThrow(WorkError);
    expect(() => normalizeTaskInput({ title: 't', ticketId: '../../etc' })).toThrow(WorkError);
  });

  it('lists only the fields that changed', () => {
    const before = normalizeTaskInput({ title: 'A', labels: 'x' });
    const after = normalizeTaskInput({ title: 'A', labels: 'x, y', status: 'done' });
    expect(diffTask(before, after)).toEqual([
      { field: 'status', from: 'todo', to: 'done' },
      { field: 'labels', from: 'x', to: 'x, y' },
    ]);
    expect(diffTask(before, before)).toEqual([]);
  });

  it('summarizes grouped counts', () => {
    const counts = summarizeCounts([
      { status: 'done', type: 'bug', count: 2, overdue: 0 },
      { status: 'todo', type: 'task', count: 1, overdue: 1 },
      { status: 'in_review', type: 'task', count: 3, overdue: 0 },
    ]);
    expect(counts.total).toBe(6);
    expect(counts.byStatus).toEqual({ todo: 1, in_progress: 0, in_review: 3, done: 2 });
    expect(counts.byType.task).toBe(4);
    expect(counts.overdue).toBe(1);
    expect(counts.percentDone).toBe(33);
    expect(summarizeCounts([]).percentDone).toBe(0);
  });
});

describe.skipIf(!hasDatabase)('work items in the database', () => {
  const label = `work-${Date.now()}`;
  let tenantA: string;
  let tenantB: string;
  let projectA: string;
  let projectA2: string;
  let projectB: string;
  let ticketA: string;
  let ticketA2: string;
  const users: Record<'owner' | 'admin' | 'reviewer' | 'otherOwner' | 'outsider', string> =
    {} as never;

  const insertTicket = async (tenantId: string, projectId: string, key: string) => {
    const [row] = await query<{ id: string }>(
      `insert into tickets (tenant_id, project_id, external_id, external_key, title, content_hash)
       values ($1, $2, $3, $3, 'Spec ' || $3, 'h') returning id`,
      [tenantId, projectId, key]
    );
    return row!.id;
  };

  beforeAll(async () => {
    tenantA = (await createTenant(`${label}-a`)).id;
    tenantB = (await createTenant(`${label}-b`)).id;
    for (const key of Object.keys({
      owner: 1,
      admin: 1,
      reviewer: 1,
      otherOwner: 1,
      outsider: 1,
    })) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      users[key as keyof typeof users] = user!.id;
    }
    await addMembership(tenantA, users.owner, 'owner');
    await addMembership(tenantA, users.admin, 'admin');
    await addMembership(tenantA, users.reviewer, 'reviewer');
    await addMembership(tenantB, users.otherOwner, 'owner');
    const opts = { unlimited: true };
    projectA = (await createProject(tenantA, { name: 'Checkout Flow', sourceType: 'file' }, opts))
      .id;
    projectA2 = (
      await createProject(tenantA, { name: 'Customer Feedback', sourceType: 'file' }, opts)
    ).id;
    projectB = (await createProject(tenantB, { name: 'Billing', sourceType: 'file' }, opts)).id;
    ticketA = await insertTicket(tenantA, projectA, `${label}-1`);
    ticketA2 = await insertTicket(tenantA, projectA2, `${label}-2`);
  });

  it('creates a task with a derived key, the actor as reporter, and a created event', async () => {
    const created = await createWorkItem(tenantA, users.reviewer, projectA, {
      title: 'Wire up payment retry',
      type: 'story',
      priority: 'high',
      assigneeId: users.admin,
      dueOn: '2020-01-01',
      labels: 'payments, retry',
      ticketId: ticketA,
    });
    expect(created).toMatchObject({ number: 1, key: 'CF-1', projectId: projectA });

    const task = await getWorkItemByNumber(tenantA, projectA, 1);
    expect(task).toMatchObject({
      title: 'Wire up payment retry',
      type: 'story',
      priority: 'high',
      status: 'todo',
      assignee_id: users.admin,
      reporter_id: users.reviewer,
      due_on: '2020-01-01',
      overdue: true,
      labels: ['payments', 'retry'],
      ticket_id: ticketA,
      ticket_key: `${label}-1`,
    });
    const events = await listWorkEvents(tenantA, { workItemId: created.id });
    expect(events.map((e) => e.kind)).toEqual(['created']);
    expect((await getProjectDetail(tenantA, projectA))?.task_key).toBe('CF');
  });

  it('gives a second project with the same initials a different key', async () => {
    const created = await createWorkItem(tenantA, users.owner, projectA2, { title: 'Survey' });
    expect(created.key).toBe('CF2-1');
  });

  it('numbers parallel creates without repeats', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createWorkItem(tenantA, users.owner, projectA, { title: `Parallel ${i}` })
      )
    );
    const numbers = results.map((r) => r.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[0]).toBe(2);
    expect(numbers.at(-1)).toBe(13);
  });

  it('refuses references outside the workspace or the task project', async () => {
    await expect(
      createWorkItem(tenantA, users.owner, projectA, { title: 't', assigneeId: users.otherOwner })
    ).rejects.toThrow(/member of this workspace/);
    await expect(
      createWorkItem(tenantA, users.owner, projectA, { title: 't', ticketId: ticketA2 })
    ).rejects.toThrow(/not in this project/);
    await expect(createWorkItem(tenantA, users.owner, projectB, { title: 't' })).rejects.toThrow(
      /not in this workspace/
    );
    await expect(createWorkItem(tenantA, users.owner, 'nope', { title: 't' })).rejects.toThrow(
      WorkError
    );
  });

  it('refuses people who are not members of the tenant', async () => {
    await expect(createWorkItem(tenantA, users.outsider, projectA, { title: 't' })).rejects.toThrow(
      /not a member/
    );
    await expect(
      createWorkItem(tenantA, users.otherOwner, projectA, { title: 't' })
    ).rejects.toThrow(/not a member/);
  });

  it('keeps another tenant from reading or changing the tasks', async () => {
    const task = (await getWorkItemByNumber(tenantA, projectA, 1))!;
    expect(await getWorkItemByNumber(tenantB, projectA, 1)).toBeNull();
    expect(await listWorkItems(tenantB, projectA)).toEqual([]);
    expect(await listWorkEvents(tenantB, { projectId: projectA })).toEqual([]);
    expect(await getProjectDetail(tenantB, projectA)).toBeNull();
    expect((await workCountRows(tenantB)).some((r) => r.project_id === projectA)).toBe(false);
    await expect(
      updateWorkItem(tenantB, users.otherOwner, task.id, { title: 'hijack' })
    ).rejects.toThrow(/not in this workspace/);
    await expect(deleteWorkItem(tenantB, users.otherOwner, task.id)).rejects.toThrow(
      /not in this workspace/
    );
    expect((await getWorkItemByNumber(tenantA, projectA, 1))?.title).toBe('Wire up payment retry');
  });

  it('records one event per changed field, with emails for people', async () => {
    const task = (await getWorkItemByNumber(tenantA, projectA, 1))!;
    const form = {
      title: task.title,
      description: '<script>alert(1)</script>',
      type: task.type,
      priority: task.priority,
      status: 'in_progress',
      assigneeId: users.reviewer,
      dueOn: task.due_on,
      labels: task.labels.join(','),
      components: '',
      ticketId: task.ticket_id,
    };
    const changes = await updateWorkItem(tenantA, users.reviewer, task.id, form);
    expect(changes.map((c) => c.field)).toEqual(['description', 'status', 'assigneeId']);
    expect(await updateWorkItem(tenantA, users.reviewer, task.id, form)).toEqual([]);

    const events = await listWorkEvents(tenantA, { workItemId: task.id });
    const assignee = events.find((e) => e.field === 'assigneeId');
    expect(assignee).toMatchObject({
      from_value: `${label}-admin@example.test`,
      to_value: `${label}-reviewer@example.test`,
    });
    expect(events.filter((e) => e.kind === 'updated')).toHaveLength(3);
    // Stored as typed; React escapes it on render.
    expect((await getWorkItemByNumber(tenantA, projectA, 1))?.description).toBe(
      '<script>alert(1)</script>'
    );
  });

  it('lets only owners and admins delete, and keeps the activity', async () => {
    const task = (await getWorkItemByNumber(tenantA, projectA, 2))!;
    await expect(deleteWorkItem(tenantA, users.reviewer, task.id)).rejects.toThrow(
      /owners and admins/
    );
    expect(await deleteWorkItem(tenantA, users.admin, task.id)).toEqual({
      projectId: projectA,
      number: 2,
    });
    expect(await getWorkItemByNumber(tenantA, projectA, 2)).toBeNull();
    const events = await listWorkEvents(tenantA, { projectId: projectA }, 200);
    expect(events.find((e) => e.kind === 'deleted')).toMatchObject({
      work_item_id: null,
      item_number: 2,
      item_title: task.title,
    });
    // A deleted number is never handed out again.
    expect((await createWorkItem(tenantA, users.owner, projectA, { title: 'after' })).number).toBe(
      14
    );
  });

  it('lets only owners and admins change project details', async () => {
    const input = { description: 'Checkout rebuild', status: 'on_hold', taskKey: 'chk' };
    await expect(updateProjectDetails(tenantA, users.reviewer, projectA, input)).rejects.toThrow(
      /owners and admins/
    );
    await expect(updateProjectDetails(tenantB, users.otherOwner, projectA, input)).rejects.toThrow(
      /not in this workspace/
    );
    await expect(
      updateProjectDetails(tenantA, users.admin, projectA, { ...input, status: 'paused' })
    ).rejects.toThrow(WorkError);
    await expect(
      updateProjectDetails(tenantA, users.admin, projectA, { ...input, taskKey: 'CF2' })
    ).rejects.toThrow(/already uses/);

    await updateProjectDetails(tenantA, users.admin, projectA, input);
    expect(await getProjectDetail(tenantA, projectA)).toMatchObject({
      description: 'Checkout rebuild',
      status: 'on_hold',
      task_key: 'CHK',
    });
    // An empty key keeps the current one.
    await updateProjectDetails(tenantA, users.admin, projectA, { ...input, taskKey: '' });
    expect((await getProjectDetail(tenantA, projectA))?.task_key).toBe('CHK');
  });

  it('counts tasks by status, type and overdue', async () => {
    const counts = summarizeCounts(await workCountRows(tenantA, projectA));
    expect(counts.total).toBe(13);
    expect(counts.byStatus.in_progress).toBe(1);
    expect(counts.byType.story).toBe(1);
    expect(counts.overdue).toBe(1);
  });
});
