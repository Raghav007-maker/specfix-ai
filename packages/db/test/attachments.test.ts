/**
 * Task attachments: who may list, download, add and remove files, the per-task limit under
 * parallel uploads, and tenant isolation. Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTACHMENTS_PER_TASK } from '@specfix/shared';
import {
  AttachmentError,
  addAttachment,
  addMembership,
  closePool,
  createProject,
  createTenant,
  createWorkItem,
  deleteAttachment,
  deleteWorkItem,
  discardAttachment,
  getAttachment,
  listAttachments,
  query,
  setProjectMember,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('task attachments', () => {
  const label = `att${Date.now()}`;
  type Who = 'owner' | 'admin' | 'reviewer' | 'outsider' | 'stranger';
  const u = {} as Record<Who, string>;
  let tenant: string;
  let otherTenant: string;
  let projectId: string;
  let taskId: string;
  const file = (name = 'shot.png') => ({ name, contentType: 'image/png', size: 1234 });

  beforeAll(async () => {
    tenant = (await createTenant(`${label} Acme`)).id;
    otherTenant = (await createTenant(`${label} Other`)).id;
    for (const key of ['owner', 'admin', 'reviewer', 'outsider', 'stranger'] as const) {
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${key}@example.test`]
      );
      u[key] = row!.id;
    }
    await addMembership(tenant, u.owner, 'owner');
    await addMembership(tenant, u.admin, 'admin');
    await addMembership(tenant, u.reviewer, 'reviewer');
    // In the workspace, but not in the project.
    await addMembership(tenant, u.outsider, 'reviewer');
    await addMembership(otherTenant, u.stranger, 'owner');
    projectId = (await createProject(tenant, { name: 'Cart', sourceType: 'file' })).id;
    await setProjectMember(tenant, u.owner, { projectId, userId: u.admin, role: 'admin' });
    await setProjectMember(tenant, u.owner, { projectId, userId: u.reviewer, role: 'reviewer' });
    taskId = (await createWorkItem(tenant, u.owner, projectId, { title: 'Checkout bug' })).id;
  });

  it('lets a project member add a file, stored under an id-only path', async () => {
    const row = await addAttachment(tenant, u.reviewer, taskId, file('../../evil name.png'));
    expect(row.storage_path).toBe(`${tenant}/${projectId}/${taskId}/${row.id}`);
    expect(row.storage_path).not.toContain('evil');
    expect(row.uploader_email).toBe(`${label}-reviewer@example.test`);
    expect((await listAttachments(tenant, u.admin, taskId)).map((a) => a.id)).toEqual([row.id]);
    expect((await getAttachment(tenant, u.owner, row.id))?.id).toBe(row.id);
  });

  it('answers someone outside the project, or another workspace, as if nothing exists', async () => {
    const [row] = await listAttachments(tenant, u.reviewer, taskId);
    await expect(addAttachment(tenant, u.outsider, taskId, file())).rejects.toBeInstanceOf(
      AttachmentError
    );
    expect(await listAttachments(tenant, u.outsider, taskId)).toEqual([]);
    expect(await getAttachment(tenant, u.outsider, row!.id)).toBeNull();
    // Another tenant's ids resolve to nothing, even for that tenant's owner.
    expect(await getAttachment(otherTenant, u.stranger, row!.id)).toBeNull();
    expect(await listAttachments(otherTenant, u.stranger, taskId)).toEqual([]);
    await expect(addAttachment(otherTenant, u.stranger, taskId, file())).rejects.toThrow();
    await expect(deleteAttachment(otherTenant, u.stranger, row!.id)).rejects.toThrow();
  });

  it('refuses forged ids without touching the database', async () => {
    expect(await getAttachment(tenant, u.owner, "x' or 1=1 --")).toBeNull();
    await expect(addAttachment(tenant, u.owner, 'not-a-uuid', file())).rejects.toThrow();
    await expect(deleteAttachment(tenant, u.owner, 'not-a-uuid')).rejects.toThrow();
  });

  it('lets the uploader or a project admin remove a file, but not another reviewer', async () => {
    const mine = await addAttachment(tenant, u.admin, taskId, file('admin.png'));
    await expect(deleteAttachment(tenant, u.reviewer, mine.id)).rejects.toThrow(/Only whoever/);
    const theirs = await addAttachment(tenant, u.reviewer, taskId, file('rev.png'));
    expect((await deleteAttachment(tenant, u.reviewer, theirs.id)).storagePath).toBe(
      theirs.storage_path
    );
    expect((await deleteAttachment(tenant, u.admin, mine.id)).fileName).toBe('admin.png');
    expect(await getAttachment(tenant, u.owner, mine.id)).toBeNull();
  });

  it('never lets parallel uploads push a task past its limit', async () => {
    const task = (await createWorkItem(tenant, u.owner, projectId, { title: 'Many files' })).id;
    const results = await Promise.allSettled(
      Array.from({ length: ATTACHMENTS_PER_TASK + 5 }, (_, i) =>
        addAttachment(tenant, u.reviewer, task, file(`f${i}.png`))
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(ATTACHMENTS_PER_TASK);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(5);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/can hold 20 files/);
  });

  it('discards a row whose upload failed', async () => {
    const row = await addAttachment(tenant, u.owner, taskId, file('broken.png'));
    await discardAttachment(tenant, row.id);
    expect(await getAttachment(tenant, u.owner, row.id)).toBeNull();
  });

  it('hands back the stored paths when its task is deleted, and drops the rows', async () => {
    const task = (await createWorkItem(tenant, u.owner, projectId, { title: 'Delete me' })).id;
    const a = await addAttachment(tenant, u.owner, task, file('a.png'));
    const b = await addAttachment(tenant, u.owner, task, file('b.png'));
    const removed = await deleteWorkItem(tenant, u.owner, task);
    expect(removed.storagePaths.sort()).toEqual([a.storage_path, b.storage_path].sort());
    const left = await query(`select 1 from work_item_attachments where work_item_id = $1`, [task]);
    expect(left).toHaveLength(0);
  });
});
