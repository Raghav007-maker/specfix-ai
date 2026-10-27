/**
 * Independent review tests for the resolution agent repository (migration 0008).
 *
 * These cover behaviour the original suite does not: what happens to a pending draft
 * when the reviewer moves to another flag, whether a conversation completes when the
 * last flag is decided on the form, whether a turn can be recorded by a request that no
 * longer holds the turn claim, staleness on re-ingest, reviewer/tenant isolation on
 * decline, and the A/B arm assignment and time-to-resolve query.
 *
 * Tests marked `it.fails` document a defect found in review: they pass while the defect
 * exists and turn red once it is fixed (at which point drop the `.fails`).
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  AgentConversationError,
  addMembership,
  applyAgentProposal,
  claimAgentTurn,
  closePool,
  createProject,
  createTenant,
  decideFlag,
  declineAgentProposal,
  findAgentConversation,
  flagsForReveal,
  ingestTicket,
  listAgentMessages,
  lockGaps,
  query,
  recordAgentTurn,
  recordAnalysis,
  releaseAgentTurn,
  resolutionArmMetrics,
  revealedFlags,
  startAgentConversation,
  startSession,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

interface World {
  tenantId: string;
  projectId: string;
  userId: string;
  otherUserId: string;
  ticketId: string;
  versionId: string;
  flagIds: string[];
  externalId: string;
}

async function user(label: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`]
  );
  if (!row) throw new Error('could not create test user');
  return row.id;
}

async function makeWorld(label: string, flagCount = 2): Promise<World> {
  const tenant = await createTenant(`agent-review-${label}`);
  const userId = await user(label);
  const otherUserId = await user(`${label}-other`);
  await addMembership(tenant.id, userId, 'owner');
  await addMembership(tenant.id, otherUserId, 'reviewer');
  const project = await createProject(tenant.id, { name: `p-${label}`, sourceType: 'file' });
  const externalId = `${label}-1`;
  const ingested = await ingestTicket(tenant.id, project.id, {
    externalId,
    externalKey: externalId,
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
    flags: Array.from({ length: flagCount }, (_, i) => ({
      category: 'missing_info' as const,
      quoted_span: '',
      what_unclear: `unclear ${i}`,
      why_it_matters: 'it matters',
      question_for_pm: `question ${i}?`,
      severity: 'high' as const,
      dedupeKey: `missing_info:${label}-${i}`,
    })),
    calls: [],
  });
  return {
    tenantId: tenant.id,
    projectId: project.id,
    userId,
    otherUserId,
    ticketId: ingested.ticket.id,
    versionId: ingested.version.id,
    flagIds: analysis.flagIds,
    externalId,
  };
}

async function conversationFor(w: World, userId = w.userId) {
  return startAgentConversation(w.tenantId, {
    ticketId: w.ticketId,
    ticketVersionId: w.versionId,
    userId,
  });
}

const accept = (note: string) => ({
  decision: 'accepted' as const,
  edited_question: '',
  resolution_note: note,
});

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

describe.skipIf(!hasDatabase)('resolution agent repository — review', () => {
  const stamp = Date.now();

  // DEFECT: recordAgentTurn supersedes every pending draft in the whole conversation,
  // not just the drafts on the flag being discussed. A reviewer who gets a draft on
  // flag A, then opens flag B (the page offers that) and sends one message, silently
  // loses flag A's draft ("Draft replaced by a later message" with no later message on A).
  it('keeps a pending draft on another flag when the reviewer talks about a second flag', async () => {
    const w = await makeWorld(`xflag-${stamp}`);
    const conv = await conversationFor(w);
    const draftA = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: 'Within 24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[1]!,
      userId: w.userId,
      opener: 'question 1?',
      pmMessage: 'What do you mean by this one?',
      reply: 'I mean …',
      proposal: null,
      calls: [],
    });
    const after = (await listAgentMessages(w.tenantId, conv.id)).find((m) => m.id === draftA.id);
    expect(after?.proposal_status).toBe('pending');
  });

  // DEFECT: a conversation is marked completed only inside applyAgentProposal. If the
  // reviewer applies some drafts here and decides the last flag on the Review tab (the
  // page explicitly invites switching), the conversation stays 'active' forever and the
  // A/B "completion rate" counts it as abandoned.
  it('completes the conversation when the last open flag is decided on the form', async () => {
    const w = await makeWorld(`complete-${stamp}`);
    const conv = await conversationFor(w);
    const draft = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: '24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    await applyAgentProposal(w.tenantId, {
      conversationId: conv.id,
      messageId: draft.id,
      userId: w.userId,
    });
    await decideFlag(w.tenantId, {
      flagId: w.flagIds[1]!,
      userId: w.userId,
      decision: 'dismissed',
    });
    const done = await findAgentConversation(w.tenantId, w.versionId, w.userId);
    expect(done?.status).toBe('completed');
  });

  // DEFECT: recordAgentTurn does not check that the caller still holds the turn claim.
  // Once a slow turn's claim goes stale and a second request takes it over, both turns
  // record, and the first one to finish clears turn_started_at — releasing the claim
  // the *other* in-flight turn holds, so a third paid turn can start immediately.
  it('refuses to record a turn whose claim was taken over by another request', async () => {
    const w = await makeWorld(`claim-${stamp}`);
    const conv = await conversationFor(w);
    const stale = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    expect(stale).toBeTruthy();
    // Turn 1 runs long; its claim goes stale and turn 2 takes over.
    await query(
      `update agent_conversations set turn_started_at = now() - interval '5 minutes' where id = $1`,
      [conv.id]
    );
    expect(await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000)).toBeTruthy();

    // Turn 1 finally finishes. It should not be able to record over turn 2's claim.
    await expect(
      recordAgentTurn(w.tenantId, {
        claimToken: stale!,
        conversationId: conv.id,
        flagId: w.flagIds[0]!,
        userId: w.userId,
        opener: 'question 0?',
        pmMessage: 'late turn',
        reply: 'late reply',
        proposal: null,
        calls: [],
      })
    ).rejects.toThrow();
  });

  it('does not let a turn whose claim was taken over free the newer claim', async () => {
    const w = await makeWorld(`claim2-${stamp}`);
    const conv = await conversationFor(w);
    const stale = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    await query(
      `update agent_conversations set turn_started_at = now() - interval '5 minutes' where id = $1`,
      [conv.id]
    );
    // Turn 2 takes over and is in flight.
    const current = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    expect(current).toBeTruthy();
    // Turn 1's late record is refused and leaves turn 2's claim in place.
    const late = recordAgentTurn(w.tenantId, {
      claimToken: stale!,
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: 'late turn',
      reply: 'late reply',
      proposal: null,
      calls: [],
    });
    await expect(late).rejects.toBeInstanceOf(AgentConversationError);
    // A third request cannot claim while turn 2 is still running.
    expect(await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000)).toBeNull();
    await releaseAgentTurn(w.tenantId, conv.id, current!);
  });

  it('refuses a decision that expected an open flag once the form decided it', async () => {
    const w = await makeWorld(`expect-open-${stamp}`);
    await decideFlag(w.tenantId, {
      flagId: w.flagIds[0]!,
      userId: w.userId,
      decision: 'dismissed',
    });
    await expect(
      decideFlag(w.tenantId, {
        flagId: w.flagIds[0]!,
        userId: w.userId,
        decision: 'accepted',
        resolutionNote: 'late draft',
        expectOpen: true,
      })
    ).rejects.toThrow(/dismissed meanwhile/);
    const [row] = await query<{ status: string; n: string }>(
      `select f.status, (select count(*) from flag_decisions d where d.flag_id = f.id)::text as n
       from flags f where f.id = $1`,
      [w.flagIds[0]]
    );
    expect(row).toEqual({ status: 'dismissed', n: '1' });
  });

  it('caps the reviewer’s wording when a draft is applied', async () => {
    const w = await makeWorld(`cap-${stamp}`);
    const conv = await conversationFor(w);
    const draft = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: '24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    await expect(
      applyAgentProposal(w.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: w.userId,
        resolutionNote: 'x'.repeat(5000),
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
    const still = (await listAgentMessages(w.tenantId, conv.id)).find((m) => m.id === draft.id);
    expect(still?.proposal_status).toBe('pending');
  });

  it('does not let another reviewer or tenant decline a draft', async () => {
    const w = await makeWorld(`decline-${stamp}`);
    const other = await makeWorld(`decline-other-${stamp}`);
    const conv = await conversationFor(w);
    const draft = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: '24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    await expect(
      declineAgentProposal(w.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: w.otherUserId,
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
    await expect(
      declineAgentProposal(other.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: w.userId,
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
    const still = (await listAgentMessages(w.tenantId, conv.id)).find((m) => m.id === draft.id);
    expect(still?.proposal_status).toBe('pending');
  });

  it('refuses to apply a draft once the ticket was re-ingested and its flag went stale', async () => {
    const w = await makeWorld(`stale-${stamp}`);
    const conv = await conversationFor(w);
    const draft = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: '24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    const reingested = await ingestTicket(w.tenantId, w.projectId, {
      externalId: w.externalId,
      externalKey: w.externalId,
      title: 'Refunds',
      descriptionText: 'Agents refund within one business day.',
      acceptanceCriteriaText: '- Agent can refund within one business day',
      raw: {},
      sourceUpdatedAt: null,
    });
    expect(reingested.version.id).not.toBe(w.versionId);
    await expect(
      applyAgentProposal(w.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: w.userId,
      })
    ).rejects.toThrow(/stale/);
    const [flag] = await query<{ status: string }>(`select status from flags where id = $1`, [
      w.flagIds[0],
    ]);
    expect(flag?.status).toBe('stale');
  });

  it('assigns a version to the agent arm if any one flag was decided from a draft', async () => {
    // Two versions: one decided entirely on the form, one with one agent draft and one
    // form decision. The second counts as the agent arm (mixed versions are not excluded).
    const w = await makeWorld(`arms-${stamp}`);
    const session = await startSession(w.tenantId, w.versionId, w.userId);
    await lockGaps(w.tenantId, session.id);
    await flagsForReveal(w.tenantId, session.id);

    const conv = await conversationFor(w);
    const draft = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: '24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    await applyAgentProposal(w.tenantId, {
      conversationId: conv.id,
      messageId: draft.id,
      userId: w.userId,
    });
    await decideFlag(w.tenantId, {
      flagId: w.flagIds[1]!,
      userId: w.userId,
      decision: 'dismissed',
    });

    const metrics = await resolutionArmMetrics(w.tenantId);
    expect(metrics.agent.versionsResolved).toBe(1);
    expect(metrics.form.versionsResolved).toBe(0);
    expect(metrics.agent.medianMinutesToResolve).not.toBeNull();
    expect(metrics.agent.flagsDecidedByAgentDraft).toBe(1);
    // ...and the conversation counts as completed though its last flag was decided on the form.
    expect(metrics.agent.completed).toBe(1);
  });

  it('shows the reviewer Critic-pruned flags through revealedFlags (what the Conversation tab lists)', async () => {
    const w = await makeWorld(`pruned-${stamp}`, 0);
    await recordAnalysis(w.tenantId, {
      ticketId: w.ticketId,
      ticketVersionId: w.versionId,
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
      flags: [
        {
          category: 'missing_info',
          quoted_span: '',
          what_unclear: 'kept',
          why_it_matters: 'm',
          question_for_pm: 'q?',
          severity: 'high',
          dedupeKey: `missing_info:pruned-keep-${stamp}`,
          criticVerdict: 'keep',
        },
        {
          category: 'missing_info',
          quoted_span: '',
          what_unclear: 'pruned',
          why_it_matters: 'm',
          question_for_pm: 'q?',
          severity: 'high',
          dedupeKey: `missing_info:pruned-drop-${stamp}`,
          criticVerdict: 'prune',
          criticReason: 'false alarm',
        },
      ],
      calls: [],
    });
    const session = await startSession(w.tenantId, w.versionId, w.userId);
    await lockGaps(w.tenantId, session.id);
    const { flags } = await revealedFlags(w.tenantId, session.id);
    // Records current behaviour: pruned flags are returned. The Conversation page then
    // counts them as "decided" (flags.length - open.length) and lists them in "All flags".
    expect(flags.map((f) => f.status).sort()).toEqual(['open', 'pruned']);
  });
});

describe.skipIf(!hasDatabase)('resolution agent repository — re-review of the fixes', () => {
  const stamp = Date.now();

  it('a refused (taken-over) turn writes nothing, its billed calls included', async () => {
    // Repository behaviour is correct (all-or-nothing); recorded here because the action
    // (actions.ts) does not log those calls elsewhere when the record is refused.
    const w = await makeWorld(`rr-calls-${stamp}`);
    const conv = await conversationFor(w);
    const stale = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    await query(
      `update agent_conversations set turn_started_at = now() - interval '5 minutes' where id = $1`,
      [conv.id]
    );
    const current = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    await expect(
      recordAgentTurn(w.tenantId, {
        claimToken: stale!,
        conversationId: conv.id,
        flagId: w.flagIds[0]!,
        userId: w.userId,
        opener: 'question 0?',
        pmMessage: 'late',
        reply: 'late reply',
        proposal: null,
        calls: [
          {
            purpose: 'agent_turn',
            promptVersion: 'resolve-flag-v1@000000000000',
            model: 'gpt-4o-mini',
            request: {},
            latencyMs: 1,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.01,
          },
        ],
      })
    ).rejects.toBeInstanceOf(AgentConversationError);
    const [row] = await query<{ n: string }>(
      `select count(*)::text as n from llm_calls where agent_conversation_id = $1`,
      [conv.id]
    );
    expect(row?.n).toBe('0');
    expect(await listAgentMessages(w.tenantId, conv.id)).toEqual([]);
    await releaseAgentTurn(w.tenantId, conv.id, current!);
  });

  it('a stale token cannot release the current claim', async () => {
    const w = await makeWorld(`rr-release-${stamp}`);
    const conv = await conversationFor(w);
    const stale = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    await query(
      `update agent_conversations set turn_started_at = now() - interval '5 minutes' where id = $1`,
      [conv.id]
    );
    const current = await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000);
    await releaseAgentTurn(w.tenantId, conv.id, stale!);
    expect(await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000)).toBeNull();
    await releaseAgentTurn(w.tenantId, conv.id, current!);
    expect(await claimAgentTurn(w.tenantId, conv.id, w.userId, 60_000)).toBeTruthy();
  });

  it('completion on the last decision completes only conversations that were used', async () => {
    const w = await makeWorld(`rr-others-${stamp}`);
    const mine = await conversationFor(w);
    await turn(w.tenantId, {
      conversationId: mine.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: 'What do you mean?',
      reply: 'I mean…',
      proposal: null,
      calls: [],
    });
    const theirs = await conversationFor(w, w.otherUserId);
    for (const flagId of w.flagIds) {
      await decideFlag(w.tenantId, { flagId, userId: w.userId, decision: 'dismissed' });
    }
    const [a, b] = await Promise.all([
      findAgentConversation(w.tenantId, w.versionId, w.userId),
      findAgentConversation(w.tenantId, w.versionId, w.otherUserId),
    ]);
    expect(a?.id).toBe(mine.id);
    expect(b?.id).toBe(theirs.id);
    // The other reviewer opened a conversation but sent nothing: not a completion.
    expect([a?.status, b?.status]).toEqual(['completed', 'active']);
  });

  it('a reopened flag after completion leaves the conversation marked completed', async () => {
    const w = await makeWorld(`rr-reopen-${stamp}`, 1);
    const used = await conversationFor(w);
    await turn(w.tenantId, {
      conversationId: used.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: 'What do you mean?',
      reply: 'I mean…',
      proposal: null,
      calls: [],
    });
    await decideFlag(w.tenantId, {
      flagId: w.flagIds[0]!,
      userId: w.userId,
      decision: 'dismissed',
    });
    await decideFlag(w.tenantId, { flagId: w.flagIds[0]!, userId: w.userId, decision: 'reopened' });
    const conv = await findAgentConversation(w.tenantId, w.versionId, w.userId);
    // Records current behaviour (low): completed_at stays at the first resolution.
    expect(conv?.status).toBe('completed');
  });

  it('a draft left pending on a flag decided on the form stays retired after a reopen', async () => {
    const w = await makeWorld(`rr-revive-${stamp}`);
    const conv = await conversationFor(w);
    const draft = await turn(w.tenantId, {
      conversationId: conv.id,
      flagId: w.flagIds[0]!,
      userId: w.userId,
      opener: 'question 0?',
      pmMessage: '24 hours.',
      reply: 'Drafted.',
      proposal: accept('Refunds within 24 hours.'),
      calls: [],
    });
    await decideFlag(w.tenantId, {
      flagId: w.flagIds[0]!,
      userId: w.userId,
      decision: 'dismissed',
    });
    await decideFlag(w.tenantId, { flagId: w.flagIds[0]!, userId: w.userId, decision: 'reopened' });
    // Deciding on the form superseded the draft, so the reopen does not revive it.
    await expect(
      applyAgentProposal(w.tenantId, {
        conversationId: conv.id,
        messageId: draft.id,
        userId: w.userId,
      })
    ).rejects.toThrow(/replaced/);
  });
});
