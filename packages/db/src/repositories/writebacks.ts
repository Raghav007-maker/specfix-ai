/**
 * Jira write-back records and the content a sign-off writes.
 *
 * claimWriteback is what makes sign-off idempotent: it takes a (version, kind) slot
 * only when nothing has been written for it yet, or the last attempt failed. A done slot
 * is never claimed again, so a double click or a retried request writes to Jira once.
 */
import { query, type TenantId } from '../client.ts';

export type WritebackKind = 'comment' | 'label';

export interface WritebackRow {
  kind: WritebackKind;
  status: 'pending' | 'done' | 'failed';
  jira_ref: string | null;
  error: string | null;
  ticket_version_id: string;
  updated_at: Date;
}

/** True when this call took the slot and should perform the write. */
export async function claimWriteback(
  tenantId: TenantId,
  input: { ticketId: string; versionId: string; kind: WritebackKind; userId: string }
): Promise<boolean> {
  const rows = await query(
    `insert into jira_writebacks (tenant_id, ticket_id, ticket_version_id, kind, requested_by)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, ticket_version_id, kind) do update
       set status = 'pending', error = null, requested_by = excluded.requested_by,
           updated_at = now()
       where jira_writebacks.status = 'failed'
          or (jira_writebacks.status = 'pending'
              and jira_writebacks.updated_at < now() - interval '5 minutes')
     returning 1`,
    [tenantId, input.ticketId, input.versionId, input.kind, input.userId]
  );
  return rows.length > 0;
}

export async function finishWriteback(
  tenantId: TenantId,
  input: { versionId: string; kind: WritebackKind; jiraRef?: string; error?: string }
): Promise<void> {
  await query(
    `update jira_writebacks
     set status = $4, jira_ref = coalesce($5, jira_ref), error = $6, updated_at = now()
     where tenant_id = $1 and ticket_version_id = $2 and kind = $3`,
    [
      tenantId,
      input.versionId,
      input.kind,
      input.error ? 'failed' : 'done',
      input.jiraRef ?? null,
      input.error ? input.error.slice(0, 500) : null,
    ]
  );
}

/** The ticket's write-back rows for its current version, for the ticket page. */
export async function currentWritebacks(
  tenantId: TenantId,
  ticketId: string
): Promise<WritebackRow[]> {
  return query<WritebackRow>(
    `select w.kind, w.status, w.jira_ref, w.error, w.ticket_version_id, w.updated_at
     from jira_writebacks w
     where w.tenant_id = $1 and w.ticket_id = $2
       and w.ticket_version_id = (
         select v.id from ticket_versions v
         where v.tenant_id = $1 and v.ticket_id = $2
         order by v.captured_at desc limit 1)
     order by w.kind`,
    [tenantId, ticketId]
  );
}

export interface SignOffContent {
  ticket_id: string;
  version_id: string;
  external_id: string;
  external_key: string;
  title: string;
  acceptance_criteria_text: string;
  jira_cloud_id: string | null;
  source_type: 'file' | 'jira';
  clarifications: Array<{ question: string; answer: string | null; decision: string }>;
}

/**
 * What a sign-off writes for the ticket's current version: its acceptance criteria and
 * every flag the PM accepted or edited, with the PM's answer (the latest decision's
 * note or rewritten text). Dismissed flags are left out — the PM judged them noise.
 */
export async function signOffContent(
  tenantId: TenantId,
  ticketId: string
): Promise<SignOffContent | null> {
  const [row] = await query<Omit<SignOffContent, 'clarifications'>>(
    `select t.id as ticket_id, v.id as version_id, t.external_id, t.external_key, v.title,
            v.acceptance_criteria_text, p.jira_cloud_id, p.source_type
     from tickets t
     join projects p on p.id = t.project_id and p.tenant_id = t.tenant_id
     join lateral (
       select id, title, acceptance_criteria_text from ticket_versions
       where tenant_id = t.tenant_id and ticket_id = t.id
       order by captured_at desc limit 1) v on true
     where t.tenant_id = $1 and t.id = $2`,
    [tenantId, ticketId]
  );
  if (!row) return null;
  const clarifications = await query<SignOffContent['clarifications'][number]>(
    `select coalesce(f.edited_question, f.question_for_pm) as question,
            coalesce(d.resolution_note, d.edited_text) as answer,
            f.status as decision
     from flags f
     left join lateral (
       select resolution_note, edited_text from flag_decisions
       where tenant_id = f.tenant_id and flag_id = f.id
       order by created_at desc limit 1) d on true
     where f.tenant_id = $1 and f.ticket_version_id = $2
       and f.status in ('accepted', 'edited')
     order by f.created_at`,
    [tenantId, row.version_id]
  );
  return { ...row, clarifications };
}
