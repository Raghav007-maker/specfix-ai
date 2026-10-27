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
import { AI_ORIGIN, isReviewed, type FlagOrigin, type FlagStatus } from '@specfix/shared';
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
  origin: FlagOrigin;
  /** Null when no Critic pass ran, which is not the same as the Critic approving it. */
  critic_verdict: 'keep' | 'prune' | null;
  critic_reason: string | null;
  /** Non-null only when the Critic rewrote the Extractor's question. */
  pre_critic_question: string | null;
  pre_critic_severity: string | null;
}

export type Decision = 'accepted' | 'edited' | 'dismissed' | 'reopened';

export interface DecideFlagInput {
  flagId: string;
  userId: string;
  decision: Decision;
  /** Required for `edited`: the reviewer's rewrite of question_for_pm. */
  editedText?: string | undefined;
  resolutionNote?: string | undefined;
  /**
   * Refuse unless the flag is still open when it is locked. The resolution agent sets it:
   * its draft was checked against an open flag earlier, and a decision posted from the
   * form in between must not be silently overwritten.
   */
  expectOpen?: boolean;
}

export class FlagDecisionError extends Error {}

/**
 * Flags for the review UI. Pruned flags are excluded: the Critic rejected them, and
 * showing them would defeat the point of the pass. `listPrunedFlagsForVersion` is
 * how the audit view and the eval control get at them.
 */
export async function listFlagsForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<FlagRow[]> {
  return query<FlagRow>(
    `${FLAG_SELECT}
     where tenant_id = $1 and ticket_version_id = $2 and status <> 'pruned'
     order by array_position(array['high','medium','low'], severity), created_at`,
    [tenantId, ticketVersionId]
  );
}

/**
 * What the Critic threw away, with its stated reason.
 *
 * Two callers, and both matter. A human auditing whether the Critic is discarding
 * real gaps — the failure mode the Critic prompt warns about, where the pass raises
 * precision by deleting good work. And the volume-matched random-pruning control,
 * which cannot show the Critic beat chance without knowing which flags it removed.
 */
export async function listPrunedFlagsForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<FlagRow[]> {
  return query<FlagRow>(
    `${FLAG_SELECT}
     where tenant_id = $1 and ticket_version_id = $2 and status = 'pruned'
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

/**
 * The resolved clarifications the Spec Compiler reads, for one version.
 *
 * A flag the reviewer accepted or edited is a decision the PM made about the
 * requirement, so it is the disambiguation the compiler should condition on. The
 * `answer` is the reviewer's resolution note when they left one — Phase 1 does not
 * force a structured answer, so it is often empty, and the compiler leans on the
 * acceptance criteria in that case. Pruned, dismissed, open and stale flags are
 * excluded: none of them is a decision the requirement now reflects.
 */
export interface ResolvedFlag {
  flagId: string;
  category: string;
  questionForPm: string;
  answer: string;
}

export async function resolvedFlagsForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<ResolvedFlag[]> {
  const rows = await query<{
    flag_id: string;
    category: string;
    question_for_pm: string;
    answer: string;
  }>(
    `select f.id as flag_id, f.category,
            coalesce(f.edited_question, f.question_for_pm) as question_for_pm,
            coalesce((
              select d.resolution_note from flag_decisions d
              where d.tenant_id = f.tenant_id and d.flag_id = f.id and d.resolution_note is not null
              order by d.created_at desc
              limit 1
            ), '') as answer
     from flags f
     where f.tenant_id = $1 and f.ticket_version_id = $2 and f.status in ('accepted', 'edited')
     order by f.created_at`,
    [tenantId, ticketVersionId]
  );
  return rows.map((r) => ({
    flagId: r.flag_id,
    category: r.category,
    questionForPm: r.question_for_pm,
    answer: r.answer,
  }));
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
    // A pruned flag never reached a reviewer, so a reviewer decision on it would be
    // a decision on something they were not shown. Overruling the Critic is a real
    // need, but it has to clear critic_verdict as well as the status, and that is a
    // separate path — not something this one should do by accident.
    if (existing.status === 'pruned') {
      throw new FlagDecisionError(
        'this flag was pruned by the Critic and was never shown for review'
      );
    }
    if (input.expectOpen && existing.status !== 'open') {
      throw new FlagDecisionError(
        `This flag was ${existing.status} meanwhile, so nothing was changed. Reopen it on the Review tab to decide it again.`
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

    // The resolution agent's records follow the flag however it was decided. Guarded so a
    // database without migration 0008 still decides flags.
    const [agent] = await rows<{ present: boolean }>(
      client,
      `select to_regclass('public.agent_messages') is not null as present`,
      []
    );
    const agentTables = agent?.present === true;

    // A decision made any other way retires the agent's undecided drafts on this flag, so a
    // later reopen cannot bring an old draft back. (Applying a draft marks it applied first.)
    if (agentTables && input.decision !== 'reopened') {
      await client.query(
        `update agent_messages set proposal_status = 'superseded'
         where tenant_id = $1 and flag_id = $2 and proposal_status = 'pending'`,
        [tenantId, input.flagId]
      );
    }

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

      // A resolution-agent conversation on this version is complete however its last flag
      // was decided — here, or on the form — provided the reviewer actually used it.
      if (agentTables) {
        await client.query(
          `update agent_conversations c set status = 'completed', completed_at = now()
           where c.tenant_id = $1 and c.ticket_version_id = $2 and c.status = 'active'
             and exists (select 1 from agent_messages m
                         where m.conversation_id = c.id and m.tenant_id = c.tenant_id)`,
          [tenantId, updated.ticket_version_id]
        );
      }
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
  ticket_id: string;
  user_email: string | null;
  category: string;
  question_for_pm: string;
  severity: string;
}

/**
 * Every decision ever recorded against any flag on a ticket, oldest first — the
 * audit trail the review UI shows. Joined to the flag so the trail reads as
 * "who decided what about which question" rather than as a list of uuids.
 *
 * Takes one ticket id, or several to read them all in one query.
 */
export async function listDecisionsForTicket(
  tenantId: TenantId,
  ticketId: string | readonly string[]
): Promise<TicketDecisionRow[]> {
  return query<TicketDecisionRow>(
    `select d.id, d.flag_id, d.user_id, d.decision, d.edited_text, d.resolution_note,
            d.created_at, u.email as user_email,
            f.ticket_id, f.category, f.question_for_pm, f.severity
     from flag_decisions d
     join flags f on f.id = d.flag_id and f.tenant_id = d.tenant_id
     left join auth.users u on u.id = d.user_id
     where d.tenant_id = $1 and f.ticket_id = any($2::uuid[])
     order by d.created_at`,
    [tenantId, [ticketId].flat()]
  );
}

/** Precision inputs straight from the database, for the metrics dashboard. */
export interface PrecisionCounts {
  reviewed: number;
  real: number;
  /**
   * Developer-raised questions in the same scope, excluded from the counts above.
   * Reported so the exclusion is visible rather than silent — a dashboard that shows
   * a shrinking denominator with no explanation invites someone to "fix" it.
   */
  developerExcluded: number;
}

/**
 * Precision over model-raised flags only.
 *
 * The `origin = 'ai_agent'` filter is the whole point of this query, not an
 * incidental condition. Precision answers "of the gaps the model raised, how many
 * were real?" A question a developer typed into the portal is real by construction —
 * a human chose to ask it — so including developer rows would push the number toward
 * 100% as adoption grows, and the metric would improve fastest exactly when the model
 * was contributing least. Removing this filter does not break a test loudly; it
 * inflates a headline result quietly.
 */
export async function precisionCounts(
  tenantId: TenantId,
  promptVersion?: string
): Promise<PrecisionCounts> {
  const [row] = await query<{ reviewed: string; real: string; developer: string }>(
    `select
       count(*) filter (
         where f.origin = $3 and f.status in ('accepted', 'edited', 'dismissed')
       )::text as reviewed,
       count(*) filter (
         where f.origin = $3 and f.status in ('accepted', 'edited')
       )::text as real,
       count(*) filter (
         where f.origin <> $3 and f.status in ('accepted', 'edited', 'dismissed')
       )::text as developer
     from flags f
     join analysis_runs r on r.id = f.analysis_run_id and r.tenant_id = f.tenant_id
     where f.tenant_id = $1
       and ($2::text is null or r.prompt_version = $2)`,
    [tenantId, promptVersion ?? null, AI_ORIGIN]
  );
  return {
    reviewed: Number(row?.reviewed ?? 0),
    real: Number(row?.real ?? 0),
    developerExcluded: Number(row?.developer ?? 0),
  };
}

const FLAG_COLUMNS = `id, tenant_id, ticket_id, ticket_version_id, category, quoted_span,
       what_unclear, why_it_matters, question_for_pm, severity, status,
       edited_question, dedupe_key, origin, critic_verdict, critic_reason,
       pre_critic_question, pre_critic_severity`;

const FLAG_SELECT = `select ${FLAG_COLUMNS} from flags`;

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
