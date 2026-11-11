/**
 * The figures behind Home's "Project work" panel and the overview's active-sprint card:
 * counted from real rows, scoped to the workspace or one project, never another tenant's.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeSprintSummaries,
  addMembership,
  closePool,
  createProject,
  createSprint,
  createTenant,
  createWorkItem,
  listWorkEvents,
  query,
  setWorkItemSprint,
  startSprint,
  summarizeCounts,
  workCountRows,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('dashboard figures', () => {
  const label = `dash-${Date.now()}`;
  let tenantA: string;
  let tenantB: string;
  let p1: string;
  let p2: string;
  let owner: string;
  let otherOwner: string;

  beforeAll(async () => {
    tenantA = (await createTenant(`${label}-a`)).id;
    tenantB = (await createTenant(`${label}-b`)).id;
    const ids: string[] = [];
    for (const who of ['owner', 'other']) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${who}@example.test`]
      );
      ids.push(user!.id);
    }
    [owner, otherOwner] = ids as [string, string];
    await addMembership(tenantA, owner, 'owner');
    await addMembership(tenantB, otherOwner, 'owner');
    const opts = { unlimited: true };
    p1 = (await createProject(tenantA, { name: 'Alpha', sourceType: 'file' }, opts)).id;
    p2 = (await createProject(tenantA, { name: 'Beta', sourceType: 'file' }, opts)).id;
    const pb = (await createProject(tenantB, { name: 'Gamma', sourceType: 'file' }, opts)).id;

    const make = (projectId: string, title: string, extra: Record<string, string> = {}) =>
      createWorkItem(tenantA, owner, projectId, { title, ...extra });
    const done = await make(p1, 'Done', { status: 'done', dueOn: '2020-01-01' });
    const review = await make(p1, 'Review', { status: 'in_review' });
    const late = await make(p1, 'Late', { dueOn: '2020-01-01' });
    await make(p2, 'Other project', { status: 'in_progress' });
    await createWorkItem(tenantB, otherOwner, pb, { title: 'Not ours', dueOn: '2020-01-01' });

    const sprint = (await createSprint(tenantA, owner, p1, { name: 'Alpha 1' })).id;
    for (const task of [done, review, late])
      await setWorkItemSprint(tenantA, owner, task.id, sprint);
    await startSprint(tenantA, owner, sprint);
    const empty = (await createSprint(tenantA, owner, p2, { name: 'Beta 1' })).id;
    await startSprint(tenantA, owner, empty);
    await createSprint(tenantA, owner, p2, { name: 'Beta 2 (planned)' });
    const remote = (await createSprint(tenantB, otherOwner, pb, { name: 'Gamma 1' })).id;
    await startSprint(tenantB, otherOwner, remote);
  });

  it('counts the workspace and one project, with overdue excluding done work', async () => {
    const all = summarizeCounts(await workCountRows(tenantA));
    expect(all).toMatchObject({ total: 4, overdue: 1, percentDone: 25 });
    expect(all.byStatus).toEqual({ todo: 1, in_progress: 1, in_review: 1, done: 1 });

    const alpha = summarizeCounts(await workCountRows(tenantA, p1));
    expect(alpha).toMatchObject({ total: 3, overdue: 1, percentDone: 33 });
  });

  it('summarizes active sprints only, including an empty one, never another tenant', async () => {
    expect(await activeSprintSummaries(tenantA)).toEqual([
      expect.objectContaining({ name: 'Alpha 1', project_name: 'Alpha', total: 3, done: 1 }),
      expect.objectContaining({ name: 'Beta 1', project_name: 'Beta', total: 0, done: 0 }),
    ]);
    expect((await activeSprintSummaries(tenantA, p2)).map((s) => s.name)).toEqual(['Beta 1']);
    expect(await activeSprintSummaries(tenantB, p1)).toEqual([]);
    expect(await activeSprintSummaries(tenantA, 'nope')).toEqual([]);
  });

  it('lists recent activity across the workspace without other tenants', async () => {
    const events = await listWorkEvents(tenantA, {}, 200);
    expect(new Set(events.map((e) => e.project_id))).toEqual(new Set([p1, p2]));
    expect(events.some((e) => e.item_title === 'Not ours')).toBe(false);
    expect(await listWorkEvents(tenantA, {}, 6)).toHaveLength(6);
  });
});
