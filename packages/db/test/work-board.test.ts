/**
 * The Kanban board: URL filters and sorting (pure), and against the test database the
 * move rules — ordering within a column, status events, tenant isolation, rank exhaustion
 * and parallel moves.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WorkError,
  addMembership,
  applyBoardQuery,
  closePool,
  createProject,
  createTenant,
  createWorkItem,
  listWorkEvents,
  moveWorkItem,
  parseBoardQuery,
  query,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('board filters', () => {
  const me = '11111111-1111-4111-8111-111111111111';
  const row = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `Task ${n}`,
    type: 'task' as 'task' | 'bug' | 'story' | 'epic',
    priority: 'medium' as 'low' | 'medium' | 'high' | 'critical',
    assignee_id: null as string | null,
    labels: [] as string[],
    components: [] as string[],
    due_on: null as string | null,
    rank: n,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...extra,
  });
  const rows = [
    row(1, {
      title: 'Fix checkout',
      priority: 'low',
      labels: ['UI'],
      due_on: '2026-12-01',
      rank: 3,
    }),
    row(2, { type: 'bug', priority: 'critical', assignee_id: me, rank: 1 }),
    row(3, { components: ['payments-api'], due_on: '2026-11-05', rank: 2 }),
  ];
  const numbers = (q: Record<string, string>) =>
    applyBoardQuery(rows, parseBoardQuery(q), { userId: me, taskKey: 'CF' }).map((r) => r.number);

  it('drops unknown or malformed filter values', () => {
    expect(
      parseBoardQuery({ type: 'incident', priority: ['high', 'low'], assignee: 'x', sort: 'evil' })
    ).toEqual({ q: '', type: null, priority: 'high', assignee: null, label: null, sort: 'rank' });
    expect(parseBoardQuery({ q: 'x'.repeat(500) }).q).toHaveLength(100);
    expect(parseBoardQuery({ assignee: me.toUpperCase() }).assignee).toBe(me);
  });

  it('filters by search, type, priority, assignee and label', () => {
    expect(numbers({})).toEqual([2, 3, 1]);
    expect(numbers({ q: 'CHECKOUT' })).toEqual([1]);
    expect(numbers({ q: 'cf-3' })).toEqual([3]);
    expect(numbers({ q: 'payments' })).toEqual([3]);
    expect(numbers({ type: 'bug' })).toEqual([2]);
    expect(numbers({ priority: 'low' })).toEqual([1]);
    expect(numbers({ assignee: 'me' })).toEqual([2]);
    expect(numbers({ assignee: 'none' })).toEqual([3, 1]);
    expect(numbers({ label: 'ui' })).toEqual([1]);
    expect(numbers({ q: 'nothing like this' })).toEqual([]);
  });

  it('sorts by priority and by due date, undated last', () => {
    expect(numbers({ sort: 'priority' })).toEqual([2, 3, 1]);
    expect(numbers({ sort: 'due' })).toEqual([3, 1, 2]);
  });
});

describe.skipIf(!hasDatabase)('moving tasks on the board', () => {
  const label = `board-${Date.now()}`;
  let tenantId: string;
  let otherTenant: string;
  let projectId: string;
  let otherProject: string;
  let userId: string;
  let otherUser: string;

  const column = async (status: string) =>
    (
      await query<{ title: string }>(
        `select title from work_items
         where tenant_id = $1 and project_id = $2 and status = $3 order by rank, number`,
        [tenantId, projectId, status]
      )
    ).map((r) => r.title);
  const make = async (title: string, status = 'todo') =>
    (await createWorkItem(tenantId, userId, projectId, { title, status })).id;

  beforeAll(async () => {
    tenantId = (await createTenant(`${label}-a`)).id;
    otherTenant = (await createTenant(`${label}-b`)).id;
    const ids: string[] = [];
    for (const who of ['member', 'other']) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${who}@example.test`]
      );
      ids.push(user!.id);
    }
    [userId, otherUser] = ids as [string, string];
    await addMembership(tenantId, userId, 'reviewer');
    await addMembership(otherTenant, otherUser, 'owner');
    const opts = { unlimited: true };
    projectId = (await createProject(tenantId, { name: 'Board', sourceType: 'file' }, opts)).id;
    otherProject = (await createProject(tenantId, { name: 'Other', sourceType: 'file' }, opts)).id;
  });

  it('reorders within a column without an event, and moves across with one', async () => {
    const a = await make('A');
    await make('B');
    const c = await make('C');
    await moveWorkItem(tenantId, userId, c, { status: 'todo', beforeId: a });
    expect(await column('todo')).toEqual(['C', 'A', 'B']);
    expect((await listWorkEvents(tenantId, { workItemId: c })).map((e) => e.kind)).toEqual([
      'created',
    ]);

    const moved = await moveWorkItem(tenantId, userId, a, { status: 'in_review' });
    expect(moved).toMatchObject({ status: 'in_review', moved: true });
    expect(await column('todo')).toEqual(['C', 'B']);
    expect(await column('in_review')).toEqual(['A']);
    const [event] = await listWorkEvents(tenantId, { workItemId: a });
    expect(event).toMatchObject({ field: 'status', from_value: 'todo', to_value: 'in_review' });
  });

  it('appends when the "before" task is elsewhere, itself, or not an id', async () => {
    const d = await make('D', 'done');
    const elsewhere = (await createWorkItem(tenantId, userId, otherProject, { title: 'X' })).id;
    const [b] = await query<{ id: string }>(
      `select id from work_items where tenant_id = $1 and project_id = $2 and title = 'B'`,
      [tenantId, projectId]
    );
    // D is in another column, so B lands at the end.
    await moveWorkItem(tenantId, userId, b!.id, { status: 'in_review', beforeId: d });
    await moveWorkItem(tenantId, userId, d, { status: 'in_review', beforeId: elsewhere });
    await moveWorkItem(tenantId, userId, d, { status: 'in_review', beforeId: d });
    await moveWorkItem(tenantId, userId, d, { status: 'in_review', beforeId: "1' or '1'='1" });
    expect(await column('in_review')).toEqual(['A', 'B', 'D']);
  });

  it('refuses bad columns, other tenants and non-members', async () => {
    const e = await make('E');
    await expect(moveWorkItem(tenantId, userId, e, { status: 'archived' })).rejects.toThrow(
      WorkError
    );
    await expect(moveWorkItem(otherTenant, otherUser, e, { status: 'done' })).rejects.toThrow(
      /not in this workspace/
    );
    await expect(moveWorkItem(tenantId, otherUser, e, { status: 'done' })).rejects.toThrow(
      /not a member/
    );
    await expect(moveWorkItem(tenantId, userId, 'nope', { status: 'done' })).rejects.toThrow(
      WorkError
    );
    expect(await column('todo')).toContain('E');
  });

  it('renumbers a column when repeated drops exhaust the gap', async () => {
    const x = await make('X', 'in_progress');
    const p = await make('P', 'in_progress');
    const q = await make('Q', 'in_progress');
    for (let i = 0; i < 70; i++) {
      await moveWorkItem(tenantId, userId, i % 2 ? q : p, { status: 'in_progress', beforeId: x });
    }
    // The last move (i = 69) put Q right before X.
    expect(await column('in_progress')).toEqual(['P', 'Q', 'X']);
    const ranks = await query<{ rank: number }>(
      `select rank from work_items
       where tenant_id = $1 and project_id = $2 and status = 'in_progress'`,
      [tenantId, projectId]
    );
    expect(new Set(ranks.map((r) => r.rank)).size).toBe(3);
  });

  it('keeps every card and one event each under parallel moves', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => make(`Par ${i}`)));
    await Promise.all(ids.map((id) => moveWorkItem(tenantId, userId, id, { status: 'done' })));
    const done = await column('done');
    expect(done.filter((t) => t.startsWith('Par '))).toHaveLength(10);
    for (const id of ids) {
      const events = await listWorkEvents(tenantId, { workItemId: id });
      expect(events.filter((e) => e.field === 'status')).toHaveLength(1);
    }
  });
});
