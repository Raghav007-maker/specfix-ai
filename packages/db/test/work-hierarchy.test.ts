/**
 * Task hierarchy (Epic → Story/Task/Bug → Sub-task), story points and sprint velocity: the
 * pure rules, and against the test database the parent checks (type, project, tenant), type
 * changes that would strand children, the activity it records, and a race between changing
 * an epic's type and adding a task under it.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
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
  getWorkItemByNumber,
  listWorkEvents,
  normalizeTaskInput,
  parentTypesFor,
  parseStoryPoints,
  query,
  sprintVelocity,
  updateWorkItem,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('hierarchy and points rules', () => {
  it('allows one level per type', () => {
    expect(parentTypesFor('epic')).toEqual([]);
    expect(parentTypesFor('story')).toEqual(['epic']);
    expect(parentTypesFor('bug')).toEqual(['epic']);
    expect(parentTypesFor('subtask')).toEqual(['story', 'task', 'bug']);
  });

  it('reads story points as a whole number from 0 to 100', () => {
    expect(parseStoryPoints('')).toBeNull();
    expect(parseStoryPoints(' 8 ')).toBe(8);
    expect(parseStoryPoints('0')).toBe(0);
    expect(parseStoryPoints('100')).toBe(100);
    for (const bad of ['-1', '101', '2.5', '1e2', 'abc', '0x10', '9999']) {
      expect(() => parseStoryPoints(bad), bad).toThrow(WorkError);
    }
  });

  it('refuses a malformed parent id before touching the database', () => {
    expect(() => normalizeTaskInput({ title: 't', parentId: "' or 1=1 --" })).toThrow(WorkError);
    expect(normalizeTaskInput({ title: 't', type: 'subtask' }).type).toBe('subtask');
  });

  it('counts velocity from completed sprints only, oldest first', () => {
    const sprints = [
      { id: 's3', name: 'S3', status: 'active' as const, completed_at: null },
      { id: 's2', name: 'S2', status: 'completed' as const, completed_at: new Date('2026-02-01') },
      { id: 's1', name: 'S1', status: 'completed' as const, completed_at: new Date('2026-01-01') },
    ];
    const tasks = [
      { sprint_id: 's1', story_points: 3 },
      { sprint_id: 's1', story_points: null },
      { sprint_id: 's2', story_points: 5 },
      { sprint_id: 's3', story_points: 8 },
      { sprint_id: null, story_points: 13 },
    ];
    expect(sprintVelocity(sprints, tasks)).toEqual([
      { sprintId: 's1', name: 'S1', points: 3, tasks: 2 },
      { sprintId: 's2', name: 'S2', points: 5, tasks: 1 },
    ]);
    expect(sprintVelocity(sprints, tasks, 1).map((v) => v.name)).toEqual(['S2']);
  });
});

describe.skipIf(!hasDatabase)('hierarchy in the database', () => {
  const label = `hier-${Date.now()}`;
  let A: string;
  let B: string;
  let pA: string;
  let pA2: string;
  let pB: string;
  const u: Record<string, string> = {};

  const workError = (p: Promise<unknown>, message?: RegExp) =>
    message ? expect(p).rejects.toThrow(message) : expect(p).rejects.toBeInstanceOf(WorkError);
  const parentOf = async (id: string) =>
    (
      await query<{ parent_id: string | null }>(`select parent_id from work_items where id = $1`, [
        id,
      ])
    )[0]!.parent_id;

  beforeAll(async () => {
    A = (await createTenant(`${label}-a`)).id;
    B = (await createTenant(`${label}-b`)).id;
    for (const name of ['owner', 'rev', 'ownerB']) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${name}@example.test`]
      );
      u[name] = row!.id;
    }
    await addMembership(A, u.owner!, 'owner');
    await addMembership(A, u.rev!, 'reviewer');
    await addMembership(B, u.ownerB!, 'owner');
    const opts = { unlimited: true };
    pA = (await createProject(A, { name: 'Alpha', sourceType: 'file' }, opts)).id;
    pA2 = (await createProject(A, { name: 'Beta', sourceType: 'file' }, opts)).id;
    pB = (await createProject(B, { name: 'Bravo', sourceType: 'file' }, opts)).id;
  });

  it('builds epic → story → sub-task with points, and shows the parent on read', async () => {
    const epic = await createWorkItem(A, u.owner!, pA, { title: 'Checkout', type: 'epic' });
    const story = await createWorkItem(A, u.rev!, pA, {
      title: 'Pay by card',
      type: 'story',
      parentId: epic.id,
      storyPoints: '5',
    });
    const sub = await createWorkItem(A, u.owner!, pA, {
      title: 'Card form',
      type: 'subtask',
      parentId: story.id,
      storyPoints: '2',
    });
    const read = await getWorkItemByNumber(A, pA, sub.number);
    expect(read).toMatchObject({
      parent_id: story.id,
      parent_number: story.number,
      parent_title: 'Pay by card',
      story_points: 2,
    });
    expect((await getWorkItemByNumber(A, pA, story.number))!.story_points).toBe(5);
  });

  it('refuses a parent of the wrong level', async () => {
    const epic = await createWorkItem(A, u.owner!, pA, { title: 'E', type: 'epic' });
    const story = await createWorkItem(A, u.owner!, pA, { title: 'S', type: 'story' });
    await workError(
      createWorkItem(A, u.owner!, pA, { title: 'x', type: 'epic', parentId: epic.id }),
      /epic cannot have a parent/
    );
    await workError(
      createWorkItem(A, u.owner!, pA, { title: 'x', type: 'story', parentId: story.id }),
      /only sit under an epic/
    );
    await workError(
      createWorkItem(A, u.owner!, pA, { title: 'x', type: 'subtask', parentId: epic.id })
    );
    const sub = await createWorkItem(A, u.owner!, pA, {
      title: 'sub',
      type: 'subtask',
      parentId: story.id,
    });
    await workError(
      createWorkItem(A, u.owner!, pA, { title: 'x', type: 'subtask', parentId: sub.id })
    );
  });

  it('refuses itself as its parent', async () => {
    const epic = await createWorkItem(A, u.owner!, pA, { title: 'Self', type: 'epic' });
    const story = await createWorkItem(A, u.owner!, pA, { title: 'Self s', type: 'story' });
    await workError(
      updateWorkItem(A, u.owner!, epic.id, { title: 'Self', type: 'epic', parentId: epic.id })
    );
    await workError(
      updateWorkItem(A, u.owner!, story.id, { title: 'Self s', type: 'story', parentId: story.id })
    );
    expect(await parentOf(story.id)).toBeNull();
  });

  it('refuses a parent in another project or another workspace', async () => {
    const otherProjectEpic = await createWorkItem(A, u.owner!, pA2, { title: 'E2', type: 'epic' });
    const otherTenantEpic = await createWorkItem(B, u.ownerB!, pB, { title: 'EB', type: 'epic' });
    await workError(
      createWorkItem(A, u.owner!, pA, { title: 'x', parentId: otherProjectEpic.id }),
      /not in this project/
    );
    await workError(
      createWorkItem(A, u.owner!, pA, { title: 'x', parentId: otherTenantEpic.id }),
      /not in this project/
    );
    // And from the other side: B cannot hang its task under A's epic.
    const epicA = await createWorkItem(A, u.owner!, pA, { title: 'EA', type: 'epic' });
    const taskB = await createWorkItem(B, u.ownerB!, pB, { title: 'tb' });
    await workError(updateWorkItem(B, u.ownerB!, taskB.id, { title: 'tb', parentId: epicA.id }));
    expect(await parentOf(taskB.id)).toBeNull();
  });

  it('refuses out-of-range points as a WorkError, not a database error', async () => {
    for (const storyPoints of ['-3', '101', '3.5', '32768', '1; drop table work_items']) {
      await workError(createWorkItem(A, u.owner!, pA, { title: 'p', storyPoints }));
    }
  });

  it('refuses a type change that would strand its children', async () => {
    const epic = await createWorkItem(A, u.owner!, pA, { title: 'Big', type: 'epic' });
    const story = await createWorkItem(A, u.owner!, pA, {
      title: 'Mid',
      type: 'story',
      parentId: epic.id,
    });
    await createWorkItem(A, u.owner!, pA, { title: 'Low', type: 'subtask', parentId: story.id });

    await workError(
      updateWorkItem(A, u.owner!, epic.id, { title: 'Big', type: 'task' }),
      /Move them first/
    );
    await workError(
      updateWorkItem(A, u.owner!, story.id, { title: 'Mid', type: 'subtask', parentId: '' })
    );
    // Story → bug keeps both levels valid.
    const changes = await updateWorkItem(A, u.owner!, story.id, {
      title: 'Mid',
      type: 'bug',
      parentId: epic.id,
    });
    expect(changes.map((c) => c.field)).toEqual(['type']);
  });

  it('records parent and points changes with task ids, not raw uuids', async () => {
    const epic = await createWorkItem(A, u.owner!, pA, { title: 'Ev', type: 'epic' });
    const task = await createWorkItem(A, u.owner!, pA, { title: 'tv' });
    const changes = await updateWorkItem(A, u.owner!, task.id, {
      title: 'tv',
      parentId: epic.id,
      storyPoints: '3',
    });
    expect(changes.map((c) => c.field).sort()).toEqual(['parentId', 'storyPoints']);
    const events = await listWorkEvents(A, { workItemId: task.id });
    const parent = events.find((e) => e.field === 'parentId')!;
    expect(parent.to_value).toBe(epic.key);
    expect(events.find((e) => e.field === 'storyPoints')!.to_value).toBe('3');
  });

  it('leaves children without a parent when the parent is deleted', async () => {
    const epic = await createWorkItem(A, u.owner!, pA, { title: 'Gone', type: 'epic' });
    const story = await createWorkItem(A, u.owner!, pA, {
      title: 'Stays',
      type: 'story',
      parentId: epic.id,
    });
    await deleteWorkItem(A, u.owner!, epic.id);
    expect(await parentOf(story.id)).toBeNull();
  });

  it('never lets a story land under a non-epic when the type change races the create', async () => {
    for (let round = 0; round < 5; round++) {
      const epic = await createWorkItem(A, u.owner!, pA, { title: `R${round}`, type: 'epic' });
      const results = await Promise.allSettled([
        updateWorkItem(A, u.owner!, epic.id, { title: `R${round}`, type: 'task' }),
        createWorkItem(A, u.rev!, pA, { title: `c${round}`, type: 'story', parentId: epic.id }),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(WorkError);
      }
      const bad = await query<{ n: number }>(
        `select count(*)::int as n from work_items c join work_items p on p.id = c.parent_id
         where c.tenant_id = $1 and c.type in ('story', 'task', 'bug') and p.type <> 'epic'`,
        [A]
      );
      expect(bad[0]!.n).toBe(0);
    }
  });
});
