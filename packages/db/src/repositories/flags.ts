/**
 * Flag review: the write path a reviewer's clicks take.
 *
 * Every status change goes through `decideFlag`, which writes both the new status and
 * an append-only `flag_decisions` row in one transaction. There is no code path that
 * changes a flag's status without leaving an audit row, because the audit trail is
 * the evidence behind the precision metric — if it can drift from the flag table,
 * the metric is unverifiable.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { isReviewed, type FlagStatus } from '@specfix/shared';
import { tx, query, type TenantId } from '../client.ts';

export interface FlagRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  ticket_version_id: string;
  category: string;
  quoted_span: string;
  what_unclear: string;
  why_it_matters: string;
  question_for_pm: string;
  severity: string;
  status: FlagStatus;
  edited_question: string | null;
  dedupe_key: string;
}

export type Decision = 'accepted' | 'edited' | 'dismissed' | 'reopened';

export interface DecideFlagInput {
  flagId: string;
  userId: string;
  decision: Decision;
  /** Required for `edited`: the reviewer's rewrite of question_for_pm. */
  editedText?: string | undefined;
  resolutionNote?: string | undefined;
}

export class FlagDecisionError extends Error {}

export async function listFlagsForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<FlagRow[]> {
  return query<FlagRow>(
    `${FLAG_SELECT}
     where tenant_id = $1 and ticket_version_id = $2
     order by array_position(array['high','medium','low'], severity), created_at`,
    [tenantId, ticketVersionId]
  );
}

export async function listOpenFlagsForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<FlagRow[]> {
  return query<FlagRow>(
    `${FLAG_SELECT}
     where tenant_id = $1 and ticket_id = $2 and status = 'open'
     order by array_position(array['high','medium','low'], severity), created_at`,
    [tenantId, ticketId]
  );
}

export async function decideFlag(tenantId: TenantId, input: DecideFlagInput): Promise<FlagRow> {
  if (input.decision === 'edited' && !input.editedText?.trim()) {
    throw new FlagDecisionError("an edited flag needs the reviewer's replacement text");
  }

  return tx(async (client) => {
    // Locked for the duration so two reviewers clicking at once cannot interleave a
    // status write with the audit row that explains it.
    const [existing] = await rows<FlagRow>(
      client,
      `${FLAG_SELECT} where tenant_id = $1 and id = $2 for update`,
      [tenantId, input.flagId]
    );

    if (!existing) {
      // Includes the cross-tenant case: another tenant's flag id is simply not found.
      throw new FlagDecisionError(`no such flag: ${input.flagId}`);
    }
    if (existing.status === 'stale') {
      throw new FlagDecisionError(
        'this flag belongs to a superseded version of the ticket and cannot be decided'
      );
    }
    if (input.decision === 'reopened' && !isReviewed(existing.status)) {
      throw new FlagDecisionError(`cannot reopen a flag that is ${existing.status}`);
    }

    const nextStatus: FlagStatus = input.decision === 'reopened' ? 'open' : input.decision;

    const [updated] = await rows<FlagRow>(
      client,
      `update flags set status = $3, edited_question = $4
       where tenant_id = $1 and id = $2
       returning ${FLAG_COLUMNS}`,
      [
        tenantId,
        input.flagId,
        nextStatus,
        // Reopening clears the rewrite; keeping it would leave the UI showing edited
        // text on a flag nobody has decided yet.
        input.decision === 'edited' ? (input.editedText as string) : null,
      ]
    );

    if (!updated) throw new FlagDecisionError(`no such flag: ${input.flagId}`);

    await client.query(
      `insert into flag_decisions (tenant_id, flag_id, user_id, decision, edited_text, resolution_note)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        input.flagId,
        input.userId,
        input.decision,
        input.editedText ?? null,
        input.resolutionNote ?? null,
      ]
    );

    // When the last open flag on this version is resolved, record it. The event is
    // what time-to-ready is measured from, so it has to be written by the same
    // transaction that resolved the flag rather than by a later sweep.
    const [remaining] = await rows<{ open: string }>(
      client,
      `select count(*)::text as open from flags
       where tenant_id = $1 and ticket_version_id = $2 and status = 'open'`,
      [tenantId, updated.ticket_version_id]
    );

    if (Number(remaining?.open ?? 0) === 0) {
      await client.query(
        `insert into readiness_events (tenant_id, ticket_id, ticket_version_id, event, user_id)
         values ($1, $2, $3, 'all_flags_resolved', $4)`,
        [tenantId, updated.ticket_id, updated.ticket_version_id, input.userId]
      );
    }

    return updated;
  });
}

export interface FlagDecisionRow {
  id: string;
  flag_id: string;
  user_id: string;
  decision: Decision;
  edited_text: string | null;
  resolution_note: string | null;
  created_at: Date;
}

export async function listDecisionsForFlag(
  tenantId: TenantId,
  flagId: string
): Promise<FlagDecisionRow[]> {
  return query<FlagDecisionRow>(
    `select id, flag_id, user_id, decision, edited_text, resolution_note, created_at
     from flag_decisions
     where tenant_id = $1 and flag_id = $2
     order by created_at`,
    [tenantId, flagId]
  );
}

export interface TicketDecisionRow extends FlagDecisionRow {
  user_email: string | null;
  category: string;
  question_for_pm: string;
  severity: string;
}

/**
 * Every decision ever recorded against any flag on a ticket, oldest first — the
 * audit trail the review UI shows. Joined to the flag so the trail reads as
 * "who decided what about which question" rather than as a list of uuids.
 */
export async function listDecisionsForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<TicketDecisionRow[]> {
  return query<TicketDecisionRow>(
    `select d.id, d.flag_id, d.user_id, d.decision, d.edited_text, d.resolution_note,
            d.created_at, u.email as user_email,
            f.category, f.question_for_pm, f.severity
     from flag_decisions d
     join flags f on f.id = d.flag_id and f.tenant_id = d.tenant_id
     left join auth.users u on u.id = d.user_id
     where d.tenant_id = $1 and f.ticket_id = $2
     order by d.created_at`,
    [tenantId, ticketId]
  );
}

/** Precision inputs straight from the database, for the metrics dashboard. */
export interface PrecisionCounts {
  reviewed: number;
  real: number;
}

export async function precisionCounts(
  tenantId: TenantId,
  promptVersion?: string
): Promise<PrecisionCounts> {
  const [row] = await query<{ reviewed: string; real: string }>(
    `select
       count(*) filter (where f.status in ('accepted', 'edited', 'dismissed'))::text as reviewed,
       count(*) filter (where f.status in ('accepted', 'edited'))::text as real
     from flags f
     join analysis_runs r on r.id = f.analysis_run_id and r.tenant_id = f.tenant_id
     where f.tenant_id = $1
       and ($2::text is null or r.prompt_version = $2)`,
    [tenantId, promptVersion ?? null]
  );
  return { reviewed: Number(row?.reviewed ?? 0), real: Number(row?.real ?? 0) };
}

const FLAG_COLUMNS = `id, tenant_id, ticket_id, ticket_version_id, category, quoted_span,
       what_unclear, why_it_matters, question_for_pm, severity, status,
       edited_question, dedupe_key`;

const FLAG_SELECT = `select ${FLAG_COLUMNS} from flags`;

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
