/**
 * The conversational resolution agent's record (migration 0008).
 *
 * The agent never decides a flag. What this module stores is the transcript, the
 * agent's drafted proposals, and the conversation's timing and cost — the A/B against
 * the form needs all three. When a person applies a draft, `applyAgentProposal` records
 * the decision through `decideFlag`, the same write the form posts to, so the audit
 * trail and the readiness events cannot tell the two UIs apart except by this module's
 * own `decision` row.
 *
 * Every function takes the tenant first, like every other repository. Conversations are
 * also per reviewer: a lookup scopes by user as well, so a teammate's transcript is not
 * readable through another reviewer's session even inside one tenant.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import {
  AGENT_RESOLUTION_MAX_CHARS,
  type AgentProposal,
  type AgentProposalDecision,
} from '@specfix/shared';
import { query, tx, type TenantId } from '../client.ts';
import { decideFlag, FlagDecisionError } from './flags.ts';

export class AgentConversationError extends Error {}

export interface AgentConversationRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  ticket_version_id: string;
  user_id: string;
  status: 'active' | 'completed';
  turn_started_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
}

export type AgentProposalStatus = 'pending' | 'applied' | 'declined' | 'superseded';

export interface AgentMessageRow {
  id: string;
  seq: string;
  conversation_id: string;
  flag_id: string;
  role: 'agent' | 'pm';
  kind: 'question' | 'reply' | 'message' | 'decision';
  content: string;
  proposal: AgentProposal | null;
  proposal_status: AgentProposalStatus | null;
  decision: AgentProposalDecision | null;
  user_id: string | null;
  created_at: Date;
}

/** One model call, as the agent turn hands it over for llm_calls. */
export interface AgentCallInput {
  purpose: 'agent_turn';
  promptVersion: string;
  model: string;
  request: unknown;
  response?: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string | null;
}

let agentTablesSeen = false;

/**
 * Whether migration 0008 has been applied. The Conversation tab shows a notice instead
 * of failing on a database that has not been migrated yet. Cached once true: a table
 * does not disappear under a running app.
 */
export async function agentTablesAvailable(): Promise<boolean> {
  if (agentTablesSeen) return true;
  const [row] = await query<{ available: boolean }>(
    `select to_regclass('public.agent_messages') is not null as available`,
    []
  );
  agentTablesSeen = row?.available === true;
  return agentTablesSeen;
}

export async function findAgentConversation(
  tenantId: TenantId,
  ticketVersionId: string,
  userId: string
): Promise<AgentConversationRow | null> {
  const [row] = await query<AgentConversationRow>(
    `${CONVERSATION_SELECT}
     where tenant_id = $1 and ticket_version_id = $2 and user_id = $3`,
    [tenantId, ticketVersionId, userId]
  );
  return row ?? null;
}

/**
 * The reviewer's conversation on a version, created on first use. Idempotent: two tabs
 * starting at once land on the same row.
 */
export async function startAgentConversation(
  tenantId: TenantId,
  input: { ticketId: string; ticketVersionId: string; userId: string }
): Promise<AgentConversationRow> {
  const [version] = await query<{ id: string }>(
    `select id from ticket_versions where tenant_id = $1 and id = $2 and ticket_id = $3`,
    [tenantId, input.ticketVersionId, input.ticketId]
  );
  if (!version) throw new AgentConversationError('no such ticket version');

  const [row] = await query<AgentConversationRow>(
    `insert into agent_conversations (tenant_id, ticket_id, ticket_version_id, user_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, ticket_version_id, user_id)
       do update set ticket_id = excluded.ticket_id
     returning ${CONVERSATION_COLUMNS}`,
    [tenantId, input.ticketId, input.ticketVersionId, input.userId]
  );
  if (!row) throw new Error('agent_conversations upsert returned no row');
  return row;
}

export async function listAgentMessages(
  tenantId: TenantId,
  conversationId: string
): Promise<AgentMessageRow[]> {
  return query<AgentMessageRow>(
    `${MESSAGE_SELECT}
     where tenant_id = $1 and conversation_id = $2
     order by seq`,
    [tenantId, conversationId]
  );
}

/**
 * Claims the conversation for one model turn. Returns a claim token, or null when another
 * turn is already in flight — a double-clicked Send, or a second tab — so only one paid
 * call runs at a time. A claim older than `staleAfterMs` is taken over: the turn that held
 * it crashed or outlived any legitimate turn.
 *
 * The token is the claim's own timestamp. Recording or releasing a turn requires it, so a
 * turn whose claim was taken over can neither write its reply nor free the claim the newer
 * turn holds.
 */
export async function claimAgentTurn(
  tenantId: TenantId,
  conversationId: string,
  userId: string,
  staleAfterMs: number
): Promise<string | null> {
  const [claimed] = await query<{ token: string }>(
    `update agent_conversations set turn_started_at = clock_timestamp()
     where tenant_id = $1 and id = $2 and user_id = $3
       and (turn_started_at is null
            or turn_started_at < now() - make_interval(secs => $4::double precision / 1000))
     returning turn_started_at::text as token`,
    [tenantId, conversationId, userId, staleAfterMs]
  );
  return claimed?.token ?? null;
}

/**
 * Releases a claim without recording a turn: the call failed before producing a reply.
 * Only the holder's token releases it; a stale holder's release is a no-op.
 */
export async function releaseAgentTurn(
  tenantId: TenantId,
  conversationId: string,
  claimToken: string
): Promise<void> {
  await query(
    `update agent_conversations set turn_started_at = null
     where tenant_id = $1 and id = $2 and turn_started_at = $3::timestamptz`,
    [tenantId, conversationId, claimToken]
  );
}

/** Spend on this conversation so far, for the per-conversation cost ceiling. */
export async function agentConversationCost(
  tenantId: TenantId,
  conversationId: string
): Promise<number> {
  const [row] = await query<{ total: string }>(
    `select coalesce(sum(cost_usd), 0)::text as total from llm_calls
     where tenant_id = $1 and agent_conversation_id = $2`,
    [tenantId, conversationId]
  );
  return Number(row?.total ?? 0);
}

export interface RecordAgentTurnInput {
  conversationId: string;
  /** From claimAgentTurn. The turn is refused if the claim was taken over meanwhile. */
  claimToken: string;
  flagId: string;
  userId: string;
  /** The deterministic opening question, written with the PM's first message on a flag. */
  opener: string | null;
  pmMessage: string;
  reply: string;
  proposal: AgentProposal | null;
  calls: readonly AgentCallInput[];
}

/**
 * Writes one completed turn: the opener if this is the first message on the flag, the
 * PM's message, the reply with any proposal, and every model call — in one transaction,
 * so a transcript never shows a message without its reply. An earlier undecided draft
 * on the same flag is superseded — only the latest draft on a flag can be applied — while
 * drafts on other flags stay applicable. Releases the turn claim, and refuses (writing
 * nothing) if this request no longer holds it.
 */
export async function recordAgentTurn(
  tenantId: TenantId,
  input: RecordAgentTurnInput
): Promise<AgentMessageRow> {
  return tx(async (client) => {
    // Release first: the update doubles as the ownership check, and the transaction rolls
    // back everything below if the claim is no longer ours.
    const released = await rows<{ id: string }>(
      client,
      `update agent_conversations set turn_started_at = null
       where tenant_id = $1 and id = $2 and turn_started_at = $3::timestamptz
       returning id`,
      [tenantId, input.conversationId, input.claimToken]
    );
    if (released.length === 0) {
      throw new AgentConversationError(
        'Another message took over this conversation while the agent was replying, so this reply was not saved.'
      );
    }

    await assertConversationFlag(client, tenantId, input.conversationId, input.flagId);

    if (input.opener) {
      await client.query(
        `insert into agent_messages (tenant_id, conversation_id, flag_id, role, kind, content)
         values ($1, $2, $3, 'agent', 'question', $4)
         on conflict (conversation_id, flag_id) where kind = 'question' do nothing`,
        [tenantId, input.conversationId, input.flagId, input.opener]
      );
    }

    await client.query(
      `update agent_messages set proposal_status = 'superseded'
       where tenant_id = $1 and conversation_id = $2 and flag_id = $3
         and proposal_status = 'pending'`,
      [tenantId, input.conversationId, input.flagId]
    );

    await client.query(
      `insert into agent_messages (tenant_id, conversation_id, flag_id, role, kind, content, user_id)
       values ($1, $2, $3, 'pm', 'message', $4, $5)`,
      [tenantId, input.conversationId, input.flagId, input.pmMessage, input.userId]
    );

    const [reply] = await rows<AgentMessageRow>(
      client,
      `insert into agent_messages (
         tenant_id, conversation_id, flag_id, role, kind, content, proposal, proposal_status
       ) values ($1, $2, $3, 'agent', 'reply', $4, $5, $6)
       returning ${MESSAGE_COLUMNS}`,
      [
        tenantId,
        input.conversationId,
        input.flagId,
        input.reply,
        input.proposal ? JSON.stringify(input.proposal) : null,
        input.proposal ? 'pending' : null,
      ]
    );
    if (!reply) throw new Error('agent_messages insert returned no row');

    await insertCalls(client, tenantId, input.conversationId, input.calls);

    return reply;
  });
}

/**
 * Logs the calls of a turn that failed (a schema failure still billed tokens) and
 * releases the claim if this turn still holds it. The calls are logged either way: they
 * were made and billed. The PM's message is not stored: the page keeps it in the box so
 * they can send it again.
 */
export async function recordFailedAgentTurn(
  tenantId: TenantId,
  conversationId: string,
  claimToken: string,
  calls: readonly AgentCallInput[]
): Promise<void> {
  await tx(async (client) => {
    await insertCalls(client, tenantId, conversationId, calls);
    await client.query(
      `update agent_conversations set turn_started_at = null
       where tenant_id = $1 and id = $2 and turn_started_at = $3::timestamptz`,
      [tenantId, conversationId, claimToken]
    );
  });
}

export interface ApplyAgentProposalInput {
  conversationId: string;
  messageId: string;
  userId: string;
  /** The reviewer's final wording. Starts as the draft; the reviewer may change it. */
  editedQuestion?: string | undefined;
  resolutionNote?: string | undefined;
}

export interface ApplyAgentProposalResult {
  decision: AgentProposalDecision;
  flagId: string;
  /** True when this decision resolved the last open flag on the version. */
  completed: boolean;
}

/**
 * Applies a drafted decision — the human gate. The decision comes from the stored draft,
 * never from the form, so a posted field cannot turn a dismissal into an acceptance; the
 * wording comes from the form, because changing it before applying is the reviewer's
 * right. The draft is claimed first, so a double-clicked Apply records one decision.
 */
export async function applyAgentProposal(
  tenantId: TenantId,
  input: ApplyAgentProposalInput
): Promise<ApplyAgentProposalResult> {
  const limits: [string, string | undefined][] = [
    ['resolution', input.resolutionNote],
    ['reworded question', input.editedQuestion],
  ];
  for (const [label, text] of limits) {
    if (text !== undefined && text.trim().length > AGENT_RESOLUTION_MAX_CHARS) {
      throw new AgentConversationError(
        `Keep the ${label} under ${AGENT_RESOLUTION_MAX_CHARS} characters.`
      );
    }
  }

  const claimed = await tx(async (client) => {
    const [message] = await rows<AgentMessageRow & { flag_status: string; version_id: string }>(
      client,
      `select ${prefixed('m', MESSAGE_COLUMNS)}, f.status as flag_status,
              c.ticket_version_id as version_id
       from agent_messages m
       join agent_conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
       join flags f on f.id = m.flag_id and f.tenant_id = m.tenant_id
       where m.tenant_id = $1 and m.id = $2 and m.conversation_id = $3 and c.user_id = $4
       for update of m`,
      [tenantId, input.messageId, input.conversationId, input.userId]
    );
    if (!message || !message.proposal) {
      throw new AgentConversationError('That draft no longer exists.');
    }
    if (message.proposal_status !== 'pending') {
      throw new AgentConversationError(
        message.proposal_status === 'applied'
          ? 'That draft was already applied.'
          : 'That draft was replaced by a later message, so it can no longer be applied.'
      );
    }
    if (message.flag_status !== 'open') {
      throw new AgentConversationError(
        `This flag is already ${message.flag_status}, so the draft was not applied. Reopen it on the Review tab to decide it again.`
      );
    }
    await client.query(
      `update agent_messages set proposal_status = 'applied' where tenant_id = $1 and id = $2`,
      [tenantId, message.id]
    );
    return message;
  });

  const proposal = claimed.proposal as AgentProposal;
  const decision = proposal.decision;
  const editedQuestion = (input.editedQuestion ?? proposal.edited_question).trim();
  const resolutionNote = (input.resolutionNote ?? proposal.resolution_note).trim();

  try {
    if (decision === 'edited' && editedQuestion === '') {
      throw new FlagDecisionError('An edited flag needs the rewritten question.');
    }
    if (decision === 'accepted' && resolutionNote === '') {
      throw new FlagDecisionError(
        'Write the resolution before accepting: it is what the requirement now says.'
      );
    }
    await decideFlag(tenantId, {
      flagId: claimed.flag_id,
      userId: input.userId,
      decision,
      editedText: decision === 'edited' ? editedQuestion : undefined,
      resolutionNote: resolutionNote === '' ? undefined : resolutionNote,
      expectOpen: true,
    });
  } catch (error) {
    // The decision did not land, so the draft is still undecided.
    await query(
      `update agent_messages set proposal_status = 'pending'
       where tenant_id = $1 and id = $2 and proposal_status = 'applied'`,
      [tenantId, claimed.id]
    );
    throw error;
  }

  return tx(async (client) => {
    await client.query(
      `insert into agent_messages (
         tenant_id, conversation_id, flag_id, role, kind, content, decision, user_id
       ) values ($1, $2, $3, 'pm', 'decision', $4, $5, $6)`,
      [
        tenantId,
        input.conversationId,
        claimed.flag_id,
        decision === 'edited'
          ? editedQuestion
          : resolutionNote || (decision === 'dismissed' ? 'Dismissed.' : ''),
        decision,
        input.userId,
      ]
    );

    // decideFlag marks the conversation complete when this was the last open flag.
    const [open] = await rows<{ open: string }>(
      client,
      `select count(*)::text as open from flags
       where tenant_id = $1 and ticket_version_id = $2 and status = 'open'`,
      [tenantId, claimed.version_id]
    );
    return { decision, flagId: claimed.flag_id, completed: Number(open?.open ?? 0) === 0 };
  });
}

/** "Not this" on a draft: the reviewer keeps talking instead. */
export async function declineAgentProposal(
  tenantId: TenantId,
  input: { conversationId: string; messageId: string; userId: string }
): Promise<void> {
  const updated = await query<{ id: string }>(
    `update agent_messages m set proposal_status = 'declined'
     from agent_conversations c
     where m.tenant_id = $1 and m.id = $2 and m.conversation_id = $3
       and c.id = m.conversation_id and c.tenant_id = m.tenant_id and c.user_id = $4
       and m.proposal_status = 'pending'
     returning m.id`,
    [tenantId, input.messageId, input.conversationId, input.userId]
  );
  if (updated.length === 0) {
    throw new AgentConversationError('That draft was already applied or replaced.');
  }
}

/**
 * The pre-registered A/B measures (Phase 2 plan §6), over one tenant. Arms are by
 * version: a version is in the agent arm when a reviewer applied at least one agent
 * draft on it, otherwise in the form arm if its flags were all resolved. Time to resolve
 * runs from the flags being revealed to the reviewer to the last flag being resolved,
 * the same span in both arms. Completion rate and cost are the agent's alone — the
 * form has no conversation to abandon and makes no model calls.
 */
export interface ResolutionArmMetrics {
  agent: {
    conversations: number;
    completed: number;
    versionsResolved: number;
    medianMinutesToResolve: number | null;
    pmMessagesPerConversation: number | null;
    flagsDecidedByAgentDraft: number;
    costUsd: number;
    costPerConversationUsd: number | null;
  };
  form: {
    versionsResolved: number;
    medianMinutesToResolve: number | null;
  };
}

export async function resolutionArmMetrics(tenantId: TenantId): Promise<ResolutionArmMetrics> {
  const [conversations] = await query<{
    started: string;
    completed: string;
    pm_messages: string;
    agent_decisions: string;
    cost: string;
  }>(
    `select
       (select count(*) from agent_conversations where tenant_id = $1)::text as started,
       (select count(*) from agent_conversations where tenant_id = $1 and status = 'completed')::text as completed,
       (select count(*) from agent_messages where tenant_id = $1 and kind = 'message')::text as pm_messages,
       (select count(*) from agent_messages where tenant_id = $1 and kind = 'decision')::text as agent_decisions,
       (select coalesce(sum(cost_usd), 0) from llm_calls
         where tenant_id = $1 and agent_conversation_id is not null)::text as cost`,
    [tenantId]
  );

  const arms = await query<{ arm: 'agent' | 'form'; resolved: string; median: string | null }>(
    `with resolved as (
       select e.ticket_version_id, min(e.occurred_at) as resolved_at
       from readiness_events e
       where e.tenant_id = $1 and e.event = 'all_flags_resolved' and e.ticket_version_id is not null
       group by e.ticket_version_id
     ),
     revealed as (
       select s.ticket_version_id, min(s.revealed_at) as revealed_at
       from labeling_sessions s
       where s.tenant_id = $1 and s.revealed_at is not null
       group by s.ticket_version_id
     ),
     agent_versions as (
       select distinct c.ticket_version_id
       from agent_messages m
       join agent_conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
       where m.tenant_id = $1 and m.kind = 'decision'
     )
     select case when a.ticket_version_id is null then 'form' else 'agent' end as arm,
            count(*)::text as resolved,
            (percentile_cont(0.5) within group (
               order by extract(epoch from (r.resolved_at - v.revealed_at)) / 60
             ))::text as median
     from resolved r
     join revealed v on v.ticket_version_id = r.ticket_version_id
     left join agent_versions a on a.ticket_version_id = r.ticket_version_id
     where r.resolved_at >= v.revealed_at
     group by 1`,
    [tenantId]
  );

  const arm = (name: 'agent' | 'form') => arms.find((a) => a.arm === name);
  const started = Number(conversations?.started ?? 0);
  const cost = Number(conversations?.cost ?? 0);

  return {
    agent: {
      conversations: started,
      completed: Number(conversations?.completed ?? 0),
      versionsResolved: Number(arm('agent')?.resolved ?? 0),
      medianMinutesToResolve: toNumber(arm('agent')?.median),
      pmMessagesPerConversation:
        started === 0 ? null : Number(conversations?.pm_messages ?? 0) / started,
      flagsDecidedByAgentDraft: Number(conversations?.agent_decisions ?? 0),
      costUsd: cost,
      costPerConversationUsd: started === 0 ? null : cost / started,
    },
    form: {
      versionsResolved: Number(arm('form')?.resolved ?? 0),
      medianMinutesToResolve: toNumber(arm('form')?.median),
    },
  };
}

async function assertConversationFlag(
  client: PoolClient,
  tenantId: TenantId,
  conversationId: string,
  flagId: string
): Promise<void> {
  const [ok] = await rows<{ id: string }>(
    client,
    `select f.id from flags f
     join agent_conversations c on c.ticket_version_id = f.ticket_version_id
                               and c.tenant_id = f.tenant_id
     where f.tenant_id = $1 and f.id = $2 and c.id = $3`,
    [tenantId, flagId, conversationId]
  );
  if (!ok) throw new AgentConversationError('That flag is not part of this conversation.');
}

async function insertCalls(
  client: PoolClient,
  tenantId: TenantId,
  conversationId: string,
  calls: readonly AgentCallInput[]
): Promise<void> {
  for (const call of calls) {
    await client.query(
      `insert into llm_calls (
         tenant_id, agent_conversation_id, purpose, prompt_version, model, request,
         response, latency_ms, input_tokens, output_tokens, cost_usd, error
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        tenantId,
        conversationId,
        call.purpose,
        call.promptVersion,
        call.model,
        JSON.stringify(call.request),
        call.response === undefined ? null : JSON.stringify(call.response),
        call.latencyMs,
        call.inputTokens,
        call.outputTokens,
        call.costUsd,
        call.error ?? null,
      ]
    );
  }
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function prefixed(alias: string, columns: string): string {
  return columns
    .split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');
}

const CONVERSATION_COLUMNS = `id, tenant_id, ticket_id, ticket_version_id, user_id, status,
       turn_started_at, started_at, completed_at`;

const CONVERSATION_SELECT = `select ${CONVERSATION_COLUMNS} from agent_conversations`;

const MESSAGE_COLUMNS = `id, seq, conversation_id, flag_id, role, kind, content, proposal,
       proposal_status, decision, user_id, created_at`;

const MESSAGE_SELECT = `select ${MESSAGE_COLUMNS} from agent_messages`;

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
