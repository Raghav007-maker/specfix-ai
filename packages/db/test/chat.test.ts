/**
 * Team conversations, @mentions and the calendar: the pure rules, and against the test
 * database who may post, who a mention reaches (members only, never the author, never another
 * workspace), mentions in task comments, task search, and a burst of parallel posts.
 *
 * The database suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChatError,
  addMembership,
  addWorkComment,
  closePool,
  createProject,
  createTenant,
  createWorkItem,
  dueTone,
  handleOf,
  listProjectMessages,
  listWorkItemsDue,
  monthGrid,
  normalizeMessage,
  parseMentions,
  parseMonth,
  postProjectMessage,
  query,
  removeMember,
  searchWorkItems,
  shiftMonth,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('mention parsing', () => {
  it('finds @handles and @emails, not emails written out or trailing punctuation', () => {
    expect(parseMentions('hi @Udit, can @shrikant.s look? cc @pm@corp.io.')).toEqual([
      'udit',
      'shrikant.s',
      'pm@corp.io',
    ]);
    expect(parseMentions('mail me at a@b.com')).toEqual([]);
    expect(parseMentions('@x @x @X')).toEqual(['x']);
    expect(parseMentions(Array.from({ length: 50 }, (_, i) => `@u${i}`).join(' '))).toHaveLength(
      20
    );
    expect(parseMentions("@'); drop table x; --")).toEqual([]);
  });

  it('derives a handle from an email and validates message length', () => {
    expect(handleOf('Udit.B@Example.com')).toBe('udit.b');
    expect(handleOf(null)).toBeNull();
    expect(normalizeMessage('  hi \r\n there ')).toBe('hi \n there');
    expect(() => normalizeMessage('   ')).toThrow(ChatError);
    expect(() => normalizeMessage('x'.repeat(4001))).toThrow(/4,000/);
  });
});

describe('calendar rules', () => {
  const today = '2026-11-16';
  const t = (due_on: string | null, priority = 'medium', status = 'todo') =>
    ({ due_on, priority, status }) as Parameters<typeof dueTone>[0];

  it('colours by time left and priority', () => {
    expect(dueTone(t(null), today)).toBeNull();
    expect(dueTone(t('2026-11-10'), today)).toBe('red');
    expect(dueTone(t('2026-11-16'), today)).toBe('red');
    expect(dueTone(t('2026-11-18'), today)).toBe('yellow');
    expect(dueTone(t('2026-11-18', 'high'), today)).toBe('red');
    expect(dueTone(t('2026-11-22', 'critical'), today)).toBe('yellow');
    expect(dueTone(t('2026-11-22'), today)).toBe('green');
    expect(dueTone(t('2026-11-01', 'critical', 'done'), today)).toBe('green');
  });

  it('builds whole Monday-first weeks covering the month', () => {
    const nov = monthGrid('2026-11');
    expect(nov[0]![0]).toBe('2026-10-26');
    expect(nov.at(-1)!.at(-1)).toBe('2026-12-06');
    expect(nov.every((w) => w.length === 7)).toBe(true);
    expect(monthGrid('2027-02').flat()).toContain('2027-02-28');
    expect(parseMonth('2026-13', today)).toBe('2026-11');
    expect(parseMonth('../x', today)).toBe('2026-11');
    expect(parseMonth('2027-02', today)).toBe('2027-02');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });
});

describe.skipIf(!hasDatabase)('conversations in the database', () => {
  const label = `chat-${Date.now()}`;
  let A: string;
  let B: string;
  let pA: string;
  let pB: string;
  const u: Record<string, string> = {};
  const email = (name: string) => `${label}-${name}@example.test`;
  const handle = (name: string) => `@${label}-${name}`;
  const mentionsOf = async (userId: string) =>
    query<{ payload: Record<string, unknown> }>(
      `select payload from notifications where user_id = $1 and kind = 'mentioned'
       order by created_at`,
      [userId]
    );

  beforeAll(async () => {
    A = (await createTenant(`${label}-a`)).id;
    B = (await createTenant(`${label}-b`)).id;
    for (const name of ['owner', 'dev', 'rev', 'gone', 'outsider']) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [email(name)]
      );
      u[name] = row!.id;
    }
    await addMembership(A, u.owner!, 'owner');
    await addMembership(A, u.dev!, 'reviewer');
    await addMembership(A, u.rev!, 'reviewer');
    await addMembership(A, u.gone!, 'reviewer');
    await addMembership(B, u.outsider!, 'owner');
    const opts = { unlimited: true };
    pA = (await createProject(A, { name: 'Alpha', sourceType: 'file' }, opts)).id;
    pB = (await createProject(B, { name: 'Bravo', sourceType: 'file' }, opts)).id;
  });

  it('posts and lists oldest first; a mention notifies members only, never the author', async () => {
    const sent = await postProjectMessage(
      A,
      u.owner!,
      pA,
      `${handle('dev')} and ${handle('outsider')} and ${handle('owner')} please check`
    );
    expect(sent.mentioned).toBe(1);
    const [m] = await mentionsOf(u.dev!);
    expect(m!.payload).toMatchObject({ chatProjectId: pA, by: email('owner') });
    expect(String(m!.payload.excerpt)).toContain('please check');
    expect(await mentionsOf(u.outsider!)).toEqual([]);
    expect(await mentionsOf(u.owner!)).toEqual([]);

    await postProjectMessage(A, u.dev!, pA, 'second');
    const list = await listProjectMessages(A, pA);
    expect(list.map((x) => x.body.slice(0, 6))).toEqual([`@${label}`.slice(0, 6), 'second']);
    expect(list[1]).toMatchObject({ author_email: email('dev') });
  });

  it('mentions by full email too, and each mention gets its own email row', async () => {
    await postProjectMessage(A, u.owner!, pA, `ping @${email('rev')}`);
    const [row] = await query<{ email_status: string }>(
      `select email_status from notifications where user_id = $1 and kind = 'mentioned'`,
      [u.rev]
    );
    expect(row?.email_status).toBe('pending');
  });

  it('refuses non-members, revoked members, other workspaces and bad input', async () => {
    await expect(postProjectMessage(A, u.outsider!, pA, 'hi')).rejects.toBeInstanceOf(ChatError);
    await expect(postProjectMessage(A, u.owner!, pB, 'hi')).rejects.toBeInstanceOf(ChatError);
    await expect(postProjectMessage(A, u.owner!, 'nope', 'hi')).rejects.toBeInstanceOf(ChatError);
    await expect(postProjectMessage(A, u.owner!, pA, ' ')).rejects.toBeInstanceOf(ChatError);
    await removeMember(A, u.owner!, u.gone!);
    await expect(postProjectMessage(A, u.gone!, pA, 'still here?')).rejects.toBeInstanceOf(
      ChatError
    );
    // A removed member is not mentionable either.
    expect((await postProjectMessage(A, u.owner!, pA, `${handle('gone')} bye`)).mentioned).toBe(0);
    expect(await listProjectMessages(B, pA)).toEqual([]);
  });

  it('@all tells everyone in the inbox but emails only people named directly', async () => {
    const statusOf = async (userId: string) =>
      (
        await query<{ email_status: string; everyone: boolean }>(
          `select email_status, (payload->>'everyone')::boolean as everyone from notifications
           where user_id = $1 and kind = 'mentioned' and payload->>'excerpt' like 'standup%'`,
          [userId]
        )
      )[0];
    const sent = await postProjectMessage(
      A,
      u.owner!,
      pA,
      `standup in 5 min @all, ${handle('dev')} please present`
    );
    // dev is named (emailed); rev is reached only through @all; the author never; outsiders never.
    expect(sent).toMatchObject({ mentioned: 1, everyone: 1 });
    expect(await statusOf(u.dev!)).toEqual({ email_status: 'pending', everyone: false });
    expect(await statusOf(u.rev!)).toEqual({ email_status: 'skipped', everyone: true });
    expect(await statusOf(u.owner!)).toBeUndefined();
    expect(await statusOf(u.outsider!)).toBeUndefined();
  });

  it('@everyone works like @all, and never queues an email', async () => {
    await postProjectMessage(A, u.dev!, pA, 'standup2 moved @everyone');
    const rows = await query<{ email_status: string }>(
      `select email_status from notifications
       where kind = 'mentioned' and payload->>'excerpt' like 'standup2%'`,
      []
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.email_status === 'skipped')).toBe(true);
  });

  it('stores HTML as plain text', async () => {
    await postProjectMessage(A, u.dev!, pA, '<img src=x onerror=alert(1)>');
    const list = await listProjectMessages(A, pA);
    expect(list.at(-1)!.body).toBe('<img src=x onerror=alert(1)>');
  });

  it('mentions in a task comment reach others, not the assignee told already', async () => {
    const task = await createWorkItem(A, u.owner!, pA, { title: 'Pay', assigneeId: u.dev! });
    const before = (await mentionsOf(u.rev!)).length;
    await addWorkComment(A, u.owner!, task.id, `${handle('rev')} ${handle('dev')} thoughts?`);
    const rev = await mentionsOf(u.rev!);
    expect(rev).toHaveLength(before + 1);
    expect(rev.at(-1)!.payload).toMatchObject({ taskId: task.id, number: task.number });
    const devMentions = (await mentionsOf(u.dev!)).filter((m) => m.payload.taskId === task.id);
    expect(devMentions).toEqual([]);
  });

  it('keeps every message under 20 parallel posts', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => postProjectMessage(A, u.dev!, pA, `burst ${i}`))
    );
    const bursts = (await listProjectMessages(A, pA)).filter((m) => m.body.startsWith('burst'));
    expect(new Set(bursts.map((m) => m.body)).size).toBe(20);
  });

  it('lists tasks due in a date range, everyone or one assignee, never another workspace', async () => {
    const mine = await createWorkItem(A, u.owner!, pA, {
      title: 'due mine',
      dueOn: '2030-03-10',
      assigneeId: u.dev!,
    });
    const theirs = await createWorkItem(A, u.owner!, pA, {
      title: 'due theirs',
      dueOn: '2030-03-20',
    });
    await createWorkItem(A, u.owner!, pA, { title: 'due later', dueOn: '2030-04-02' });
    await createWorkItem(B, u.outsider!, pB, { title: 'due elsewhere', dueOn: '2030-03-11' });
    const ids = async (assignee?: string) =>
      (await listWorkItemsDue(A, '2030-03-01', '2030-03-31', assignee)).map((r) => r.id);
    expect(await ids()).toEqual([mine.id, theirs.id]);
    expect(await ids(u.dev!)).toEqual([mine.id]);
    expect(await listWorkItemsDue(A, "2030-03-01' or '1'='1", '2030-03-31')).toEqual([]);
    expect(await listWorkItemsDue(A, '2030-03-01', '2030-03-31', 'nope')).toEqual([]);
  });

  it('searches task titles and ids within the workspace, wildcards literal', async () => {
    const t = await createWorkItem(A, u.owner!, pA, { title: '100% done_ish' });
    await createWorkItem(B, u.outsider!, pB, { title: '100% done_ish elsewhere' });
    expect((await searchWorkItems(A, '100%')).map((r) => r.id)).toEqual([t.id]);
    expect((await searchWorkItems(A, '%')).map((r) => r.id)).toEqual([t.id]);
    expect(await searchWorkItems(A, '___')).toEqual([]);
    expect((await searchWorkItems(A, t.key.toLowerCase())).map((r) => r.id)).toEqual([t.id]);
    expect(await searchWorkItems(A, '   ')).toEqual([]);
  });
});
