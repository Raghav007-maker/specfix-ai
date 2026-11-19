/**
 * Files attached to tasks: the rows that say which file belongs to which task, and who may
 * see, add or remove them. The bytes live in the private `task-attachments` Storage bucket,
 * which the web app reads and writes with the service role only after these checks pass.
 *
 * The rules:
 *   - anyone who can see the task's project can list, download and add files;
 *   - a file is removed by whoever added it, or by the project's admin or a workspace owner;
 *   - a task holds at most ATTACHMENTS_PER_TASK files. The add takes the task's row lock, so
 *     parallel uploads cannot push it past the limit.
 *
 * A file someone cannot see is answered exactly like one that does not exist.
 */
import type { PoolClient } from 'pg';
import { ATTACHMENTS_PER_TASK } from '@specfix/shared';
import { tx, query, type TenantId } from '../client.ts';
import { projectRoleWith } from './project-members.ts';

export class AttachmentError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'That file is not in this workspace.';
const TASK_MISSING = 'That task is not in this workspace.';

export interface AttachmentRow {
  id: string;
  project_id: string;
  work_item_id: string;
  uploaded_by: string | null;
  uploader_email: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  created_at: Date;
}

const SELECT = `
  select a.id, a.project_id, a.work_item_id, a.uploaded_by, u.email as uploader_email,
         a.file_name, a.content_type, a.size_bytes, a.storage_path, a.created_at
  from work_item_attachments a
  left join auth.users u on u.id = a.uploaded_by`;

async function taskInTenant(
  client: Pick<PoolClient, 'query'>,
  tenantId: TenantId,
  itemId: string,
  lock: boolean
): Promise<{ id: string; project_id: string } | null> {
  if (!UUID.test(itemId)) return null;
  const { rows } = await client.query<{ id: string; project_id: string }>(
    `select id, project_id from work_items where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [tenantId, itemId]
  );
  return rows[0] ?? null;
}

/**
 * Records a new file on a task before its bytes are stored, inside one transaction that
 * checks the person can see the project and that the task has room. Returns the row with the
 * Storage path to upload to; if the upload then fails, the caller calls discardAttachment.
 */
export async function addAttachment(
  tenantId: TenantId,
  actorId: string,
  itemId: string,
  file: { name: string; contentType: string; size: number }
): Promise<AttachmentRow> {
  return tx(async (client) => {
    const task = await taskInTenant(client, tenantId, itemId, true);
    if (!task) throw new AttachmentError(TASK_MISSING);
    const role = await projectRoleWith(client, tenantId, task.project_id, actorId);
    if (!role) throw new AttachmentError(TASK_MISSING);
    const {
      rows: [count],
    } = await client.query<{ n: number }>(
      `select count(*)::int as n from work_item_attachments where tenant_id = $1 and work_item_id = $2`,
      [tenantId, task.id]
    );
    if ((count?.n ?? 0) >= ATTACHMENTS_PER_TASK) {
      throw new AttachmentError(
        `A task can hold ${ATTACHMENTS_PER_TASK} files. Remove one to add another.`
      );
    }
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `insert into work_item_attachments
         (tenant_id, project_id, work_item_id, uploaded_by, file_name, content_type, size_bytes,
          storage_path)
       values ($1, $2, $3, $4, $5, $6, $7, '')
       returning id`,
      [tenantId, task.project_id, task.id, actorId, file.name, file.contentType, file.size]
    );
    if (!row) throw new Error('attachment insert returned no row');
    // The path is built only from ids, never from the file's own name.
    const path = `${tenantId}/${task.project_id}/${task.id}/${row.id}`;
    await client.query(
      `update work_item_attachments set storage_path = $3 where tenant_id = $1 and id = $2`,
      [tenantId, row.id, path]
    );
    const {
      rows: [full],
    } = await client.query<AttachmentRow>(`${SELECT} where a.tenant_id = $1 and a.id = $2`, [
      tenantId,
      row.id,
    ]);
    return full!;
  });
}

/** Drops a row whose upload failed. Only the row added in the same request is passed here. */
export async function discardAttachment(tenantId: TenantId, attachmentId: string): Promise<void> {
  if (!UUID.test(attachmentId)) return;
  await query(`delete from work_item_attachments where tenant_id = $1 and id = $2`, [
    tenantId,
    attachmentId,
  ]);
}

/** A task's files, oldest first, for someone who can see its project; else an empty list. */
export async function listAttachments(
  tenantId: TenantId,
  actorId: string,
  itemId: string
): Promise<AttachmentRow[]> {
  return tx(async (client) => {
    const task = await taskInTenant(client, tenantId, itemId, false);
    if (!task || !(await projectRoleWith(client, tenantId, task.project_id, actorId))) return [];
    const { rows } = await client.query<AttachmentRow>(
      `${SELECT} where a.tenant_id = $1 and a.work_item_id = $2 order by a.created_at, a.id`,
      [tenantId, task.id]
    );
    return rows;
  });
}

/** One file, for a download, when the person can see its project; else null. */
export async function getAttachment(
  tenantId: TenantId,
  actorId: string,
  attachmentId: string
): Promise<AttachmentRow | null> {
  if (!UUID.test(attachmentId)) return null;
  return tx(async (client) => {
    const { rows } = await client.query<AttachmentRow>(
      `${SELECT} where a.tenant_id = $1 and a.id = $2`,
      [tenantId, attachmentId]
    );
    const row = rows[0];
    if (!row || !(await projectRoleWith(client, tenantId, row.project_id, actorId))) return null;
    return row;
  });
}

/**
 * Removes a file's row: by whoever added it, or by the project's admin or a workspace owner.
 * Returns the Storage path for the caller to delete, and where the file was.
 */
export async function deleteAttachment(
  tenantId: TenantId,
  actorId: string,
  attachmentId: string
): Promise<{ storagePath: string; projectId: string; workItemId: string; fileName: string }> {
  if (!UUID.test(attachmentId)) throw new AttachmentError(NOT_FOUND);
  return tx(async (client) => {
    const { rows } = await client.query<AttachmentRow>(
      `${SELECT} where a.tenant_id = $1 and a.id = $2 for update of a`,
      [tenantId, attachmentId]
    );
    const row = rows[0];
    const role = row ? await projectRoleWith(client, tenantId, row.project_id, actorId) : null;
    if (!row || !role) throw new AttachmentError(NOT_FOUND);
    if (row.uploaded_by !== actorId && role === 'reviewer') {
      throw new AttachmentError('Only whoever added a file, or a project admin, can remove it.');
    }
    await client.query(`delete from work_item_attachments where tenant_id = $1 and id = $2`, [
      tenantId,
      row.id,
    ]);
    return {
      storagePath: row.storage_path,
      projectId: row.project_id,
      workItemId: row.work_item_id,
      fileName: row.file_name,
    };
  });
}
