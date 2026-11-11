/**
 * Task collaboration and its links to SpecFix's specs: comments, task-to-task links,
 * scenario links, and bugs filed from a failing CI result.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WorkError,
  addMembership,
  addWorkComment,
  addWorkLink,
  buildBugDescription,
  closePool,
  createProject,
  createTenant,
  createWorkItem,
  deleteWorkComment,
  deleteWorkItem,
  fileBugFromScenario,
  getWorkItemByNumber,
  linkLabel,
  listWorkComments,
  listWorkEvents,
  listWorkItemsForTicket,
  listWorkLinks,
  moveWorkItem,
  normalizeComment,
  query,
  removeWorkLink,
  updateWorkItem,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('collaboration rules', () => {
  it('normalizes comments and refuses empty or oversized ones', () => {
    expect(normalizeComment('  hi\r\nthere  ')).toBe('hi\nthere');
    expect(() => normalizeComment('   ')).toThrow(WorkError);
    expect(() => normalizeComment(null)).toThrow(WorkError);
    expect(() => normalizeComment('x'.repeat(10001))).toThrow(/10,000/);
  });

  it('reads links from both sides', () => {
    expect(linkLabel('blocks', 'out')).toBe('blocks');
    expect(linkLabel('blocks', 'in')).toBe('is blocked by');
    expect(linkLabel('duplicates', 'in')).toBe('is duplicated by');
    expect(linkLabel('relates', 'in')).toBe('relates to');
  });

  it('describes a bug from its CI result, truncating a long error', () => {
    const at = new Date('2026-11-01T10:20:00Z');
    const text = buildBugDescription({
      ticketKey: 'CART-1',
      scenarioTitle: 'Pay by UPI',
      result: {
        status: 'failed',
        error: 'e'.repeat(5000),
        branch: 'main',
        commit_sha: 'abcdef123',
        received_at: at,
      },
    });
    expect(text).toContain('scenario "Pay by UPI" on spec ticket CART-1');
    expect(text).toContain('failed on main at abcdef1 (2026-11-01 10:20 UTC)');
    expect(text).toContain('…(truncated)');
    expect(text.length).toBeLessThan(4300);
    expect(buildBugDescription({ ticketKey: 'X-1', scenarioTitle: 's', result: null })).toContain(
      'No CI result'
    );
  });
});

describe.skipIf(!hasDatabase)('collaboration in the database', () => {
  const label = `collab-${Date.now()}`;
  let tenantA: string;
  let tenantB: string;
  let projectP: string;
  let projectQ: string;
  let projectR: string;
  const users: Record<'owner' | 'rev' | 'rev2' | 'otherOwner' | 'outsider', string> = {} as never;
  const ids: Record<string, string> = {};

  /** A ticket with one version and one scenario; returns both ids. */
  async function specFixture(tenantId: string, projectId: string, key: string) {
    const [ticket] = await query<{ id: string }>(
      `insert into tickets (tenant_id, project_id, external_id, external_key, title, content_hash)
       values ($1, $2, $3, $3, 'Spec ' || $3, 'h') returning id`,
      [tenantId, projectId, key]
    );
    const [version] = await query<{ id: string }>(
      `insert into ticket_versions
         (tenant_id, ticket_id, content_hash, title, description_text, acceptance_criteria_text)
       values ($1, $2, 'h', 't', '', '') returning id`,
      [tenantId, ticket!.id]
    );
    const [scenario] = await query<{ id: string }>(
      `insert into scenarios (tenant_id, ticket_id, ticket_version_id, title, gherkin_raw, status, dedupe_key)
       values ($1, $2, $3, 'Scenario ' || $4, 'Feature: x', 'approved', $4) returning id`,
      [tenantId, ticket!.id, version!.id, key]
    );
    return { ticketId: ticket!.id, scenarioId: scenario!.id };
  }

  beforeAll(async () => {
    tenantA = (await createTenant(`${label}-a`)).id;
    tenantB = (await createTenant(`${label}-b`)).id;
    for (const key of Object.keys({ owner: 1, rev: 1, rev2: 1, otherOwner: 1, outsider: 1 })) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      users[key as keyof typeof users] = user!.id;
    }
    await addMembership(tenantA, users.owner, 'owner');
    await addMembership(tenantA, users.rev, 'reviewer');
    await addMembership(tenantA, users.rev2, 'reviewer');
    await addMembership(tenantB, users.otherOwner, 'owner');
    const opts = { unlimited: true };
    projectP = (await createProject(tenantA, { name: 'Payments', sourceType: 'file' }, opts)).id;
    projectQ = (await createProject(tenantA, { name: 'Queue', sourceType: 'file' }, opts)).id;
    projectR = (await createProject(tenantB, { name: 'Remote', sourceType: 'file' }, opts)).id;

    const s1 = await specFixture(tenantA, projectP, `${label}-1`);
    const s2 = await specFixture(tenantA, projectP, `${label}-2`);
    const sq = await specFixture(tenantA, projectQ, `${label}-q`);
    const sb = await specFixture(tenantB, projectR, `${label}-b`);
    Object.assign(ids, {
      t1: s1.ticketId,
      s1: s1.scenarioId,
      t2: s2.ticketId,
      s2: s2.scenarioId,
      sq: sq.scenarioId,
      sb: sb.scenarioId,
    });

    const [run] = await query<{ id: string }>(
      `insert into ci_runs (tenant_id, project_id, branch, commit_sha, total, failed)
       values ($1, $2, 'main', 'abc1234def', 1, 1) returning id`,
      [tenantA, projectP]
    );
    await query(
      `insert into ci_results (tenant_id, ci_run_id, scenario_id, status, error)
       values ($1, $2, $3, 'failed', $4)`,
      [tenantA, run!.id, ids.s1, `<script>alert(1)</script> ${'x'.repeat(9000)}`]
    );
  });

  it('links a scenario and takes its ticket, refusing scenarios from elsewhere', async () => {
    const created = await createWorkItem(tenantA, users.rev, projectP, {
      title: 'Cover UPI',
      scenarioId: ids.s1,
    });
    const task = (await getWorkItemByNumber(tenantA, projectP, created.number))!;
    expect(task).toMatchObject({ scenario_id: ids.s1, ticket_id: ids.t1 });
    expect(task.scenario_title).toBe(`Scenario ${label}-1`);

    await expect(
      createWorkItem(tenantA, users.rev, projectP, {
        title: 'x',
        ticketId: ids.t2,
        scenarioId: ids.s1,
      })
    ).rejects.toThrow(/different spec ticket/);
    await expect(
      createWorkItem(tenantA, users.rev, projectP, { title: 'x', scenarioId: ids.sq })
    ).rejects.toThrow(/not in this project/);
    await expect(
      createWorkItem(tenantA, users.rev, projectP, { title: 'x', scenarioId: ids.sb })
    ).rejects.toThrow(/not in this project/);

    await updateWorkItem(tenantA, users.rev, task.id, {
      title: task.title,
      scenarioId: ids.s2,
    });
    const after = (await getWorkItemByNumber(tenantA, projectP, created.number))!;
    expect(after).toMatchObject({ scenario_id: ids.s2, ticket_id: ids.t2 });
    const events = await listWorkEvents(tenantA, { workItemId: task.id });
    expect(events.find((e) => e.field === 'scenarioId')).toMatchObject({
      from_value: `Scenario ${label}-1`,
      to_value: `Scenario ${label}-2`,
    });
  });

  it('files one bug per failing scenario, even under parallel clicks', async () => {
    const first = await fileBugFromScenario(tenantA, users.rev, ids.s1!);
    expect(first.existing).toBe(false);
    const bug = (await getWorkItemByNumber(tenantA, projectP, first.number))!;
    expect(bug).toMatchObject({
      type: 'bug',
      priority: 'high',
      scenario_id: ids.s1,
      ticket_id: ids.t1,
      reporter_id: users.rev,
    });
    expect(bug.title).toBe(`Failing scenario: Scenario ${label}-1`);
    expect(bug.description).toContain('failed on main at abc1234');
    expect(bug.description).toContain('<script>alert(1)</script>');
    expect(bug.description).toContain('…(truncated)');

    const again = await fileBugFromScenario(tenantA, users.owner, ids.s1!);
    expect(again).toMatchObject({ existing: true, number: first.number });

    // Once that bug is done, a new failure gets a new bug — exactly one, however many clicks.
    await moveWorkItem(tenantA, users.rev, first.id, { status: 'done' });
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => fileBugFromScenario(tenantA, users.rev, ids.s1!))
    );
    expect(new Set(burst.map((b) => b.number)).size).toBe(1);
    expect(burst.filter((b) => !b.existing)).toHaveLength(1);
    const bugs = (await listWorkItemsForTicket(tenantA, ids.t1!)).filter((t) => t.type === 'bug');
    expect(bugs).toHaveLength(2);
  });

  it('keeps bug filing inside the tenant', async () => {
    await expect(fileBugFromScenario(tenantB, users.otherOwner, ids.s1!)).rejects.toThrow(
      /not in this workspace/
    );
    await expect(fileBugFromScenario(tenantA, users.outsider, ids.s1!)).rejects.toThrow(
      /not a member/
    );
    await expect(fileBugFromScenario(tenantA, users.rev, 'nope')).rejects.toThrow(WorkError);
    expect(await listWorkItemsForTicket(tenantB, ids.t1!)).toEqual([]);
  });

  it('lets members comment; only the author, an owner or an admin deletes', async () => {
    const task = await createWorkItem(tenantA, users.rev, projectP, { title: 'Discuss' });
    const c1 = await addWorkComment(tenantA, users.rev, task.id, '  First <b>take</b>  ');
    const c2 = await addWorkComment(tenantA, users.rev2, task.id, 'Second');
    expect((await listWorkComments(tenantA, task.id)).map((c) => c.body)).toEqual([
      'First <b>take</b>',
      'Second',
    ]);
    expect(
      (await listWorkEvents(tenantA, { workItemId: task.id })).filter((e) => e.kind === 'commented')
    ).toHaveLength(2);

    await expect(addWorkComment(tenantA, users.rev, task.id, ' ')).rejects.toThrow(WorkError);
    await expect(addWorkComment(tenantB, users.otherOwner, task.id, 'hi')).rejects.toThrow(
      /not in this workspace/
    );
    await expect(deleteWorkComment(tenantA, users.rev2, c1.id)).rejects.toThrow(/author/);
    await expect(deleteWorkComment(tenantB, users.otherOwner, c1.id)).rejects.toThrow(
      /not in this workspace/
    );
    await deleteWorkComment(tenantA, users.rev2, c2.id);
    await deleteWorkComment(tenantA, users.owner, c1.id);
    expect(await listWorkComments(tenantA, task.id)).toEqual([]);
    expect(await listWorkComments(tenantB, task.id)).toEqual([]);
  });

  it('links tasks of one project, once, readable from both sides', async () => {
    const a = await createWorkItem(tenantA, users.rev, projectP, { title: 'A' });
    const b = await createWorkItem(tenantA, users.rev, projectP, { title: 'B' });
    const c = await createWorkItem(tenantA, users.rev, projectP, { title: 'C' });
    const elsewhere = await createWorkItem(tenantA, users.rev, projectQ, { title: 'Q' });
    const remote = await createWorkItem(tenantB, users.otherOwner, projectR, { title: 'R' });

    expect(
      await addWorkLink(tenantA, users.rev, { fromId: a.id, toId: b.id, kind: 'blocks' })
    ).toEqual({ added: true });
    expect(
      await addWorkLink(tenantA, users.rev, { fromId: a.id, toId: b.id, kind: 'blocks' })
    ).toEqual({ added: false });
    await addWorkLink(tenantA, users.rev, { fromId: a.id, toId: c.id, kind: 'relates' });
    expect(
      await addWorkLink(tenantA, users.rev, { fromId: c.id, toId: a.id, kind: 'relates' })
    ).toEqual({ added: false });

    const fromA = await listWorkLinks(tenantA, a.id);
    expect(fromA.map((l) => [l.kind, l.direction, l.other_title])).toEqual([
      ['blocks', 'out', 'B'],
      ['relates', 'out', 'C'],
    ]);
    expect(
      (await listWorkLinks(tenantA, b.id)).map((l) => [l.kind, l.direction, l.other_title])
    ).toEqual([['blocks', 'in', 'A']]);

    for (const bad of [
      { fromId: a.id, toId: a.id, kind: 'blocks' },
      { fromId: a.id, toId: elsewhere.id, kind: 'blocks' },
      { fromId: a.id, toId: remote.id, kind: 'blocks' },
      { fromId: a.id, toId: b.id, kind: 'causes' },
      { fromId: a.id, toId: "x' or 1=1 --", kind: 'blocks' },
    ]) {
      await expect(addWorkLink(tenantA, users.rev, bad)).rejects.toThrow(WorkError);
    }
    await expect(
      addWorkLink(tenantB, users.otherOwner, { fromId: a.id, toId: b.id, kind: 'relates' })
    ).rejects.toThrow(/not in this workspace/);
    expect(
      await removeWorkLink(tenantB, users.otherOwner, { fromId: a.id, toId: b.id, kind: 'blocks' })
    ).toEqual({ removed: false });

    expect(
      await removeWorkLink(tenantA, users.rev, { fromId: a.id, toId: b.id, kind: 'blocks' })
    ).toEqual({ removed: true });
    const kinds = (await listWorkEvents(tenantA, { workItemId: a.id })).map((e) => e.kind);
    expect(kinds).toContain('linked');
    expect(kinds).toContain('unlinked');

    // Deleting a task removes its links with it.
    await deleteWorkItem(tenantA, users.owner, c.id);
    expect(await listWorkLinks(tenantA, a.id)).toEqual([]);
  });
});
