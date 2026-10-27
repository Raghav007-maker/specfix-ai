/**
 * The resolution agent's repository (migration 0008).
 *
 * What these check is the agent's place behind the human gate: a turn writes a
 * transcript and its calls but never a flag decision; applying a draft records exactly
 * one decision through decideFlag, from the stored draft rather than the form; a draft
 * cannot be applied twice, after it was replaced, or once the flag was decided elsewhere;
 * one turn runs at a time per conversation; and nothing is reachable across tenants or
 * across reviewers.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentConversationError,
  addMembership,
  agentConversationCost,
  agentTablesAvailable,
  applyAgentProposal,
  claimAgentTurn,
  closePool,
  createProject,
  createTenant,
  decideFlag,
  declineAgentProposal,
  findAgentConversation,
  ingestTicket,
  listAgentMessages,
  listDecisionsForFlag,
  query,
  recordAgentTurn,
  recordAnalysis,
  recordFailedAgentTurn,
  releaseAgentTurn,
  resolutionArmMetrics,
  startAgentConversation,
  type AgentCallInput,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

interface World {
  tenantId: string;
  userId: string;
  otherUserId: string;
  ticketId: string;
  versionId: string;
  flagIds: string[];
}

const call = (cost = 0.001): AgentCallInput => ({
  purpose: 'agent_turn',
  promptVersion: 'resolve-flag-v1@000000000000',
  model: 'gpt-4o-mini',
  request: { messages: [] },
  response: { ok: true },
  latencyMs: 10,
  inputTokens: 100,
  outputTokens: 20,
  costUsd: cost,
});

async function user(label: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`]
  );
  if (!row) throw new Error('could not create test user');
  return row.id;
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createTenant(`agent-${label}`);
  const userId = await user(label);
  const otherUserId = await user(`${label}-other`);
  await addMembership(tenant.id, userId, 'owner');
  await addMembership(tenant.id, otherUserId, 'reviewer');
  const project = await createProject(tenant.id, { name: `p-${label}`, sourceType: 'file' });
  const ingested = await ingestTicket(tenant.id, project.id, {
    externalId: `${label}-1`,
    externalKey: `${label}-1`,
    title: 'Refunds',
    descriptionText: 'Agents refund quickly.',
    acceptanceCriteriaText: '- Agent can refund quickly',
    raw: {},
    sourceUpdatedAt: null,
  });
  const analysis = await recordAnalysis(tenant.id, {
    ticketId: ingested.ticket.id,
    ticketVersionId: ingested.version.id,
    meta: {
      promptVersion: 'single-shot-v1@000000000000',
      model: 'gpt-4o-mini',
      temperature: 0,
      seed: 1,
      truncated: false,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
    flags: ['one', 'two'].map((n) => ({
      category: 'missing_info' as const,
      quoted_span: '',
      what_unclear: `unclear ${n}`,
      why_it_matters: 'it matters',
      question_for_pm: `question ${n}?`,
      severity: 'high' as const,
      dedupeKey: `missing_info:${label}-${n}`,
    })),
    calls: [],
  });
  return {
    tenantId: tenant.id,
    userId,
    otherUserId,
    ticketId: ingested.ticket.id,
    versionId: ingested.version.id,
    flagIds: analysis.flagIds,
  };
}

async function flagStatus(tenantId: string, flagId: string): Promise<string> {
  const [row] = await query<{ status: string }>(
    `select status from flags where tenant_id = $1 and id = $2`,
    [tenantId, flagId]
  );
  return row?.status ?? 'missing';
}

/**
 * Claims the conversation and records one turn, as the send action does. A stale window
 * of 0 takes over any leftover claim, so one test's refused turn cannot block the next.
 */
async function turn(
  tenantId: string,
  input: Omit<Parameters<typeof recordAgentTurn>[1], 'claimToken'>
) {
  const claimToken = await claimAgentTurn(tenantId, input.conversationId, input.userId, 0);
  if (!claimToken) throw new Error('could not claim the conversation');
  return recordAgentTurn(tenantId, { ...input, claimToken });
}

describe.skipIf(!hasDatabase)('resolution agent repository', () => {
  let a: World;
  let b: World;

  beforeAll(async () => {
    a = await makeWorld(`a-${Date.now()}`);
    b = await makeWorld(`b-${Date.now()}`);
  });

  it('sees the migration', async () => {
    expect(await agentTablesAvailable()).toBe(true);
  });

  it('starts one conversation per reviewer and version, idempotently', async () => {
    const first = await startAgentConversation(a.tenantId, {
      ticketId: a.ticketId,
      ticketVersionId: a.versionId,
      userId: a.userId,
    });
    const again = await startAgentConversation(a.tenantId, {
      ticketId: a.ticketId,
      ticketVersionId: a.versionId,
      userId: a.userId,
    });
    expect(again.id).toBe(first.id);
    const other = await startAgentConversation(a.tenantId, {
      ticketId: a.ticketId,
      ticketVersionId: a.versionId,
      userId: a.otherUserId,
    });
    expect(other.id).not.toBe(first.id);
  });

  it('refuses to start a conversation on another tenant’s version', async () => {
    await expect(
      startAgentConversation(a.tenantId, {
        ticketId: b.ticketId,
        ticketVersionId: b.versionId,
        userId: a.userId,
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
  });

  it('lets one turn run at a time, and takes over a stale claim', async () => {
    const conv = await findAgentConversation(a.tenantId, a.versionId, a.userId);
    if (!conv) throw new Error('expected a conversation');

    const first = await claimAgentTurn(a.tenantId, conv.id, a.userId, 60_000);
    expect(first).toBeTruthy();
    expect(await claimAgentTurn(a.tenantId, conv.id, a.userId, 60_000)).toBeNull();
    await releaseAgentTurn(a.tenantId, conv.id, first!);
    // Another reviewer cannot claim this reviewer's conversation at all.
    expect(await claimAgentTurn(a.tenantId, conv.id, a.otherUserId, 60_000)).toBeNull();
    // Nor can another tenant.
    expect(await claimAgentTurn(b.tenantId, conv.id, a.userId, 60_000)).toBeNull();

    const held = await claimAgentTurn(a.tenantId, conv.id, a.userId, 60_000);
    expect(held).toBeTruthy();
    // A claim older than the stale window is taken over.
    await query(
      `update agent_conversations set turn_started_at = now() - interval '5 minutes' where id = $1`,
      [conv.id]
    );
    const taken = await claimAgentTurn(a.tenantId, conv.id, a.userId, 60_000);
    expect(taken).toBeTruthy();
    // The stale holder's release is a no-op; the new holder's claim stands.
    await releaseAgentTurn(a.tenantId, conv.id, held!);
    expect(await claimAgentTurn(a.tenantId, conv.id, a.userId, 60_000)).toBeNull();
    await releaseAgentTurn(a.tenantId, conv.id, taken!);
  });

  it('records a turn — opener once, message, reply, calls — without deciding the flag', async () => {
    const conv = await findAgentConversation(a.tenantId, a.versionId, a.userId);
    if (!conv) throw new Error('expected a conversation');
    const flagId = a.flagIds[0]!;

    await turn(a.tenantId, {
      conversationId: conv.id,
      flagId,
      userId: a.userId,
      opener: 'question one?',
      pmMessage: 'Hmm, what do you mean?',
      reply: 'I mean the refund window.',
      proposal: null,
      calls: [call()],
    });
    await turn(a.tenantId, {
      conversationId: conv.id,
      flagId,
      userId: a.userId,
      opener: 'question one?', // a second tab racing: must not duplicate the opener
      pmMessage: 'Within 24 hours.',
      reply: 'Drafted.',
      proposal: {
        decision: 'accepted',
        edited_question: '',
        resolution_note: 'Refunds are issued within 24 hours.',
      },
      calls: [call()],
    });

    const messages = await listAgentMessages(a.tenantId, conv.id);
    expect(messages.map((m) => m.kind)).toEqual([
      'question',
      'message',
      'reply',
      'message',
      'reply',
    ]);
    expect(messages.at(-1)?.proposal_status).toBe('pending');
    expect(await flagStatus(a.tenantId, flagId)).toBe('open');
    expect(await agentConversationCost(a.tenantId, conv.id)).toBeCloseTo(0.002, 6);

    // The turn released its claim.
    const after = await claimAgentTurn(a.tenantId, conv.id, a.userId, 60_000);
    expect(after).toBeTruthy();
    await releaseAgentTurn(a.tenantId, conv.id, after!);

    // Another tenant reads nothing.
    expect(await listAgentMessages(b.tenantId, conv.id)).toEqual([]);
  });

  it('refuses a turn about a flag from another version or tenant', async () => {
    const conv = await findAgentConversation(a.tenantId, a.versionId, a.userId);
    if (!conv) throw new Error('expected a conversation');
    await expect(
      turn(a.tenantId, {
        conversationId: conv.id,
        flagId: b.flagIds[0]!,
        userId: a.userId,
        opener: null,
        pmMessage: 'x',
        reply: 'y',
        proposal: null,
        calls: [],
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
  });

  it('applies a draft once, from the stored decision, with the reviewer’s wording', async () => {
    const conv = await findAgentConversation(a.tenantId, a.versionId, a.userId);
    if (!conv) throw new Error('expected a conversation');
    const draft = (await listAgentMessages(a.tenantId, conv.id)).at(-1)!;
    const flagId = a.flagIds[0]!;

    // Not by another reviewer, and not from another tenant.
    await expect(
      applyAgentProposal(a.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: a.otherUserId,
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
    await expect(
      applyAgentProposal(b.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: a.userId,
      })
    ).rejects.toBeInstanceOf(AgentConversationError);

    // An accept with the resolution blanked is refused, and the draft stays applicable.
    await expect(
      applyAgentProposal(a.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: a.userId,
        resolutionNote: '   ',
      })
    ).rejects.toThrow(/resolution/i);

    const result = await applyAgentProposal(a.tenantId, {
      conversationId: conv.id,
      messageId: draft.id,
      userId: a.userId,
      resolutionNote: 'Refunds are issued within 24 hours of the request.',
    });
    expect(result).toEqual({ decision: 'accepted', flagId, completed: false });
    expect(await flagStatus(a.tenantId, flagId)).toBe('accepted');

    const decisions = await listDecisionsForFlag(a.tenantId, flagId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.resolution_note).toBe(
      'Refunds are issued within 24 hours of the request.'
    );

    await expect(
      applyAgentProposal(a.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: a.userId,
      })
    ).rejects.toThrow(/already applied/);
    expect(await listDecisionsForFlag(a.tenantId, flagId)).toHaveLength(1);
  });

  it('does not apply a draft whose flag was decided on the form meanwhile', async () => {
    const conv = await findAgentConversation(a.tenantId, a.versionId, a.userId);
    if (!conv) throw new Error('expected a conversation');
    const flagId = a.flagIds[1]!;
    const draft = await turn(a.tenantId, {
      conversationId: conv.id,
      flagId,
      userId: a.userId,
      opener: 'question two?',
      pmMessage: 'Not a real gap, AC covers it.',
      reply: 'Drafted a dismissal.',
      proposal: { decision: 'dismissed', edited_question: '', resolution_note: 'AC covers it.' },
      calls: [],
    });

    await decideFlag(a.tenantId, { flagId, userId: a.userId, decision: 'dismissed' });
    await expect(
      applyAgentProposal(a.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: a.userId,
      })
    ).rejects.toThrow(/replaced/);
    expect(await listDecisionsForFlag(a.tenantId, flagId)).toHaveLength(1);

    // Reopen: the old draft stays retired, so the reviewer talks again and applies a new one.
    await decideFlag(a.tenantId, { flagId, userId: a.userId, decision: 'reopened' });
    await expect(
      applyAgentProposal(a.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: a.userId,
      })
    ).rejects.toThrow(/replaced/);
    const fresh = await turn(a.tenantId, {
      conversationId: conv.id,
      flagId,
      userId: a.userId,
      opener: null,
      pmMessage: 'Still not a gap.',
      reply: 'Drafted a dismissal again.',
      proposal: { decision: 'dismissed', edited_question: '', resolution_note: 'AC covers it.' },
      calls: [],
    });
    const result = await applyAgentProposal(a.tenantId, {
      conversationId: conv.id,
      messageId: fresh.id,
      userId: a.userId,
    });
    expect(result.completed).toBe(true);
    const done = await findAgentConversation(a.tenantId, a.versionId, a.userId);
    expect(done?.status).toBe('completed');
    expect(done?.completed_at).not.toBeNull();
  });

  it('supersedes an older draft when the conversation moves on, and declines on request', async () => {
    const conv = await startAgentConversation(b.tenantId, {
      ticketId: b.ticketId,
      ticketVersionId: b.versionId,
      userId: b.userId,
    });
    const flagId = b.flagIds[0]!;
    const first = await turn(b.tenantId, {
      conversationId: conv.id,
      flagId,
      userId: b.userId,
      opener: 'q?',
      pmMessage: 'a',
      reply: 'draft 1',
      proposal: { decision: 'accepted', edited_question: '', resolution_note: 'one' },
      calls: [],
    });
    const second = await turn(b.tenantId, {
      conversationId: conv.id,
      flagId,
      userId: b.userId,
      opener: null,
      pmMessage: 'actually, b',
      reply: 'draft 2',
      proposal: { decision: 'accepted', edited_question: '', resolution_note: 'two' },
      calls: [],
    });

    await expect(
      applyAgentProposal(b.tenantId, {
        conversationId: conv.id,
        messageId: first.id,
        userId: b.userId,
      })
    ).rejects.toThrow(/replaced/);

    await declineAgentProposal(b.tenantId, {
      conversationId: conv.id,
      messageId: second.id,
      userId: b.userId,
    });
    await expect(
      applyAgentProposal(b.tenantId, {
        conversationId: conv.id,
        messageId: second.id,
        userId: b.userId,
      })
    ).rejects.toThrow(/replaced|no longer/);
    await expect(
      declineAgentProposal(b.tenantId, {
        conversationId: conv.id,
        messageId: second.id,
        userId: b.userId,
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
    expect(await flagStatus(b.tenantId, flagId)).toBe('open');
  });

  it('logs a failed turn’s calls and releases the claim', async () => {
    const conv = await findAgentConversation(b.tenantId, b.versionId, b.userId);
    if (!conv) throw new Error('expected a conversation');
    const before = await agentConversationCost(b.tenantId, conv.id);
    const claim = await claimAgentTurn(b.tenantId, conv.id, b.userId, 60_000);
    await recordFailedAgentTurn(b.tenantId, conv.id, claim!, [{ ...call(0.003), error: 'schema' }]);
    expect(await agentConversationCost(b.tenantId, conv.id)).toBeCloseTo(before + 0.003, 6);
    const next = await claimAgentTurn(b.tenantId, conv.id, b.userId, 60_000);
    expect(next).toBeTruthy();
    await releaseAgentTurn(b.tenantId, conv.id, next!);
  });

  it('allows a call at most one run reference, the conversation included', async () => {
    // Asserted on the constraint definition rather than by provoking a violation: the
    // local single-connection test server drops the socket after a statement error.
    const [row] = await query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'llm_calls_one_run_check'`
    );
    expect(row?.def).toMatch(
      /num_nonnulls\(analysis_run_id, compile_run_id, agent_conversation_id\) <= 1/
    );
    const [purpose] = await query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'llm_calls_purpose_check'`
    );
    expect(purpose?.def).toContain("'agent_turn'");
  });

  it('reports the A/B measures per tenant', async () => {
    const metrics = await resolutionArmMetrics(a.tenantId);
    expect(metrics.agent.conversations).toBe(2);
    // Only the conversation that was used completes; the other reviewer never wrote.
    expect(metrics.agent.completed).toBe(1);
    expect(metrics.agent.flagsDecidedByAgentDraft).toBe(2);
    expect(metrics.agent.pmMessagesPerConversation).toBe(2);
    expect(metrics.agent.costUsd).toBeCloseTo(0.002, 6);

    const other = await resolutionArmMetrics(b.tenantId);
    expect(other.agent.conversations).toBe(1);
    expect(other.agent.flagsDecidedByAgentDraft).toBe(0);
  });
});
