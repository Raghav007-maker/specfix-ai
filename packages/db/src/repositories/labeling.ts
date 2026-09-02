/**
 * The blind-first labeling flow.
 *
 * This module is where the recall metric is either earned or quietly destroyed. The
 * ordering is: write your own gaps → lock them → see the model's flags → link.
 * If a reviewer sees the model's flags before writing their own list, their list is
 * anchored to the model's output and the recall denominator becomes meaningless.
 *
 * So the ordering is enforced here, at the point where flags are fetched, not in the
 * UI. `flagsForReveal` refuses to return anything until `gaps_locked_at` is set.
 * A front-end that forgets the sequence gets an error, not a subtly broken metric.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { tx, query, type TenantId } from '../client.ts';
import { type FlagRow } from './flags.ts';

export type LabelingStage = 'blind_gaps' | 'reveal' | 'link' | 'done';

export interface LabelingSessionRow {
  id: string;
  tenant_id: string;
  ticket_version_id: string;
  reviewer_id: string;
  stage: LabelingStage;
  gaps_locked_at: Date | null;
  revealed_at: Date | null;
  completed_at: Date | null;
}

export interface ReviewerGapRow {
  id: string;
  labeling_session_id: string;
  ticket_version_id: string;
  reviewer_id: string;
  description: string;
  matched_flag_id: string | null;
  matched_at: Date | null;
}

export class LabelingOrderError extends Error {}

/** Idempotent: a reviewer resuming an interrupted session gets the same row back. */
export async function startSession(
  tenantId: TenantId,
  ticketVersionId: string,
  reviewerId: string
): Promise<LabelingSessionRow> {
  const [session] = await query<LabelingSessionRow>(
    `insert into labeling_sessions (tenant_id, ticket_version_id, reviewer_id)
     values ($1, $2, $3)
     on conflict (tenant_id, ticket_version_id, reviewer_id) do update
       set stage = labeling_sessions.stage
     returning ${SESSION_COLUMNS}`,
    [tenantId, ticketVersionId, reviewerId]
  );
  if (!session) throw new Error('labeling_sessions upsert returned no row');
  return session;
}

/**
 * The reviewer's session for this version, or null if they have not started one.
 *
 * Separate from `startSession` because a page render must be able to ask "where is
 * this reviewer up to?" without creating a session as a side effect of looking.
 */
export async function findSession(
  tenantId: TenantId,
  ticketVersionId: string,
  reviewerId: string
): Promise<LabelingSessionRow | null> {
  const [session] = await query<LabelingSessionRow>(
    `select ${SESSION_COLUMNS} from labeling_sessions
     where tenant_id = $1 and ticket_version_id = $2 and reviewer_id = $3`,
    [tenantId, ticketVersionId, reviewerId]
  );
  return session ?? null;
}

export async function addGap(
  tenantId: TenantId,
  sessionId: string,
  description: string
): Promise<ReviewerGapRow> {
  if (!description.trim()) {
    throw new LabelingOrderError('a gap needs a description');
  }

  return tx(async (client) => {
    const session = await loadSession(client, tenantId, sessionId);

    // After the lock, the list is the denominator. Appending to it once the model's
    // flags are visible is how recall silently becomes 100%.
    if (session.gaps_locked_at !== null) {
      throw new LabelingOrderError(
        'gaps are locked for this session; they cannot be added after the reveal'
      );
    }

    const [gap] = await rows<ReviewerGapRow>(
      client,
      `insert into reviewer_gaps (
         tenant_id, labeling_session_id, ticket_version_id, reviewer_id, description
       ) values ($1, $2, $3, $4, $5)
       returning ${GAP_COLUMNS}`,
      [tenantId, sessionId, session.ticket_version_id, session.reviewer_id, description.trim()]
    );
    if (!gap) throw new Error('reviewer_gaps insert returned no row');
    return gap;
  });
}

export async function removeGap(
  tenantId: TenantId,
  sessionId: string,
  gapId: string
): Promise<void> {
  await tx(async (client) => {
    const session = await loadSession(client, tenantId, sessionId);
    if (session.gaps_locked_at !== null) {
      throw new LabelingOrderError('gaps are locked for this session and cannot be removed');
    }
    await client.query(
      `delete from reviewer_gaps
       where tenant_id = $1 and labeling_session_id = $2 and id = $3`,
      [tenantId, sessionId, gapId]
    );
  });
}

/**
 * Locks the gap list and moves to the reveal stage. Deliberately allows locking an
 * empty list: "I see no gaps in this ticket" is a real and useful label, and forcing
 * a reviewer to invent one to proceed would corrupt the data.
 */
export async function lockGaps(tenantId: TenantId, sessionId: string): Promise<LabelingSessionRow> {
  return tx(async (client) => {
    const session = await loadSession(client, tenantId, sessionId);
    if (session.gaps_locked_at !== null) return session;

    const [updated] = await rows<LabelingSessionRow>(
      client,
      `update labeling_sessions
         set gaps_locked_at = now(), stage = 'reveal'
       where tenant_id = $1 and id = $2
       returning ${SESSION_COLUMNS}`,
      [tenantId, sessionId]
    );
    if (!updated) throw new Error('labeling_sessions update returned no row');
    return updated;
  });
}

/**
 * The model's flags — available only after the gap list is locked.
 *
 * This is the gate. Every path that shows flags to a reviewer during labeling must
 * come through here.
 */
export async function flagsForReveal(
  tenantId: TenantId,
  sessionId: string
): Promise<{ session: LabelingSessionRow; flags: FlagRow[] }> {
  return tx(async (client) => {
    const session = await loadSession(client, tenantId, sessionId);

    if (session.gaps_locked_at === null) {
      throw new LabelingOrderError(
        "model flags cannot be revealed before the reviewer's own gap list is locked"
      );
    }

    if (session.revealed_at === null) {
      await client.query(
        `update labeling_sessions set revealed_at = now(), stage = 'link'
         where tenant_id = $1 and id = $2`,
        [tenantId, sessionId]
      );
    }

    const flags = await rows<FlagRow>(
      client,
      `select id, tenant_id, ticket_id, ticket_version_id, category, quoted_span,
              what_unclear, why_it_matters, question_for_pm, severity, status,
              edited_question, dedupe_key
       from flags
       where tenant_id = $1 and ticket_version_id = $2 and status <> 'stale'
       order by array_position(array['high','medium','low'], severity), created_at`,
      [tenantId, session.ticket_version_id]
    );

    return { session: await loadSession(client, tenantId, sessionId), flags };
  });
}

/**
 * The same gate as `flagsForReveal`, without the write.
 *
 * `flagsForReveal` is the *transition* — it stamps revealed_at and is called once,
 * from an explicit reviewer action. This is the *read*, called on every subsequent
 * render. Splitting them keeps a page load (or a router prefetch) from silently
 * timestamping a reveal the reviewer never saw, while still re-checking the lock on
 * every single read rather than trusting the caller to have checked it.
 */
export async function revealedFlags(
  tenantId: TenantId,
  sessionId: string
): Promise<{ session: LabelingSessionRow; flags: FlagRow[] }> {
  const [session] = await query<LabelingSessionRow>(
    `select ${SESSION_COLUMNS} from labeling_sessions
     where tenant_id = $1 and id = $2`,
    [tenantId, sessionId]
  );
  if (!session) throw new LabelingOrderError(`no such labeling session: ${sessionId}`);

  if (session.gaps_locked_at === null) {
    throw new LabelingOrderError(
      "model flags cannot be revealed before the reviewer's own gap list is locked"
    );
  }

  const flags = await query<FlagRow>(
    `select id, tenant_id, ticket_id, ticket_version_id, category, quoted_span,
            what_unclear, why_it_matters, question_for_pm, severity, status,
            edited_question, dedupe_key
     from flags
     where tenant_id = $1 and ticket_version_id = $2 and status <> 'stale'
     order by array_position(array['high','medium','low'], severity), created_at`,
    [tenantId, session.ticket_version_id]
  );

  return { session, flags };
}

/** Links one of the reviewer's gaps to a model flag that covers it. */
export async function linkGap(
  tenantId: TenantId,
  sessionId: string,
  gapId: string,
  flagId: string | null
): Promise<ReviewerGapRow> {
  return tx(async (client) => {
    const session = await loadSession(client, tenantId, sessionId);
    if (session.revealed_at === null) {
      throw new LabelingOrderError('flags have not been revealed for this session yet');
    }

    if (flagId !== null) {
      // Scoped to the same tenant and version: linking across versions would credit
      // a flag raised against different ticket text.
      const [flag] = await rows<{ id: string }>(
        client,
        `select id from flags
         where tenant_id = $1 and id = $2 and ticket_version_id = $3`,
        [tenantId, flagId, session.ticket_version_id]
      );
      if (!flag) {
        throw new LabelingOrderError('that flag does not belong to this ticket version');
      }
    }

    const [gap] = await rows<ReviewerGapRow>(
      client,
      `update reviewer_gaps
         set matched_flag_id = $4, matched_at = case when $4::uuid is null then null else now() end
       where tenant_id = $1 and labeling_session_id = $2 and id = $3
       returning ${GAP_COLUMNS}`,
      [tenantId, sessionId, gapId, flagId]
    );
    if (!gap) throw new LabelingOrderError(`no such gap in this session: ${gapId}`);
    return gap;
  });
}

export async function completeSession(
  tenantId: TenantId,
  sessionId: string
): Promise<LabelingSessionRow> {
  return tx(async (client) => {
    const session = await loadSession(client, tenantId, sessionId);
    if (session.revealed_at === null) {
      throw new LabelingOrderError('cannot complete a session that never reached the reveal stage');
    }

    const [updated] = await rows<LabelingSessionRow>(
      client,
      `update labeling_sessions set stage = 'done', completed_at = now()
       where tenant_id = $1 and id = $2
       returning ${SESSION_COLUMNS}`,
      [tenantId, sessionId]
    );
    if (!updated) throw new Error('labeling_sessions update returned no row');
    return updated;
  });
}

export async function listGaps(tenantId: TenantId, sessionId: string): Promise<ReviewerGapRow[]> {
  return query<ReviewerGapRow>(
    `select ${GAP_COLUMNS} from reviewer_gaps
     where tenant_id = $1 and labeling_session_id = $2
     order by created_at`,
    [tenantId, sessionId]
  );
}

/**
 * Recall inputs straight from the database. Only completed sessions count — a
 * half-finished session has unlinked gaps that are not yet misses.
 */
export interface RecallCounts {
  gaps: number;
  matched: number;
}

export async function recallCounts(
  tenantId: TenantId,
  promptVersion?: string
): Promise<RecallCounts> {
  const [row] = await query<{ gaps: string; matched: string }>(
    `select count(*)::text as gaps,
            count(g.matched_flag_id)::text as matched
     from reviewer_gaps g
     join labeling_sessions s
       on s.id = g.labeling_session_id and s.tenant_id = g.tenant_id
     where g.tenant_id = $1
       and s.stage = 'done'
       and ($2::text is null or exists (
         select 1 from analysis_runs r
         where r.tenant_id = g.tenant_id
           and r.ticket_version_id = g.ticket_version_id
           and r.prompt_version = $2
       ))`,
    [tenantId, promptVersion ?? null]
  );
  return { gaps: Number(row?.gaps ?? 0), matched: Number(row?.matched ?? 0) };
}

/**
 * Ticket versions labeled by more than one reviewer — the overlap the inter-rater
 * agreement check reads.
 */
export async function doubleLabeledVersions(tenantId: TenantId): Promise<string[]> {
  const rows_ = await query<{ ticket_version_id: string }>(
    `select ticket_version_id
     from labeling_sessions
     where tenant_id = $1 and stage = 'done'
     group by ticket_version_id
     having count(distinct reviewer_id) > 1`,
    [tenantId]
  );
  return rows_.map((r) => r.ticket_version_id);
}

const SESSION_COLUMNS = `id, tenant_id, ticket_version_id, reviewer_id, stage,
       gaps_locked_at, revealed_at, completed_at`;

const GAP_COLUMNS = `id, labeling_session_id, ticket_version_id, reviewer_id,
       description, matched_flag_id, matched_at`;

async function loadSession(
  client: PoolClient,
  tenantId: TenantId,
  sessionId: string
): Promise<LabelingSessionRow> {
  const [session] = await rows<LabelingSessionRow>(
    client,
    `select ${SESSION_COLUMNS} from labeling_sessions
     where tenant_id = $1 and id = $2
     for update`,
    [tenantId, sessionId]
  );
  // Also the cross-tenant case: another tenant's session id is simply not found.
  if (!session) throw new LabelingOrderError(`no such labeling session: ${sessionId}`);
  return session;
}

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
