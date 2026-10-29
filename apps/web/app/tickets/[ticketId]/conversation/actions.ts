'use server';

/**
 * The Conversation tab's writes: send a message to the resolution agent, and apply or
 * decline the decision it drafts.
 *
 * Same rules as the Review tab's actions. The tenant comes from the signed-in user's
 * membership, never from the form; a posted ticketId from another tenant resolves to
 * nothing. The blind-first rule holds here too: no flag is read, and no model call is
 * made, until this reviewer's own gap list is locked. And the agent decides nothing —
 * `applyProposalAction` is the human gate, and it records the decision through the same
 * `decideFlag` the form uses.
 *
 * `sendAgentMessage` returns a state instead of redirecting, so a failed send leaves
 * the reviewer's words in the box to retry rather than discarding them.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { normalizeAgentMessage } from '@specfix/shared';
import { SchemaValidationError, callsFromError } from '@specfix/core';
import {
  agentSettings,
  agentTurn,
  agentTurnDeadlineMs,
  openingQuestion,
  type AgentFlag,
} from '@specfix/agent';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { agentAccess, type AgentAccess } from '@/lib/plan';
import {
  AgentConversationError,
  FlagDecisionError,
  agentConversationCost,
  agentTablesAvailable,
  applyAgentProposal,
  claimAgentTurn,
  declineAgentProposal,
  findSession,
  getTicket,
  isOverTokenCap,
  latestVersion,
  listAgentMessages,
  recordAgentTurn,
  recordFailedAgentTurn,
  releaseAgentTurn,
  revealedFlags,
  startAgentConversation,
  type AgentCallInput,
  type FlagRow,
} from '@/lib/repos';

export interface SendState {
  status: 'idle' | 'sent' | 'error';
  error?: string;
  /** Changes on every successful send, so the composer knows to clear itself. */
  sentAt?: number;
}

interface Context {
  userId: string;
  tenantId: string;
  ticketId: string;
  agent: AgentAccess;
}

/** Why the agent cannot run, for the reviewer; null when it can. */
function agentRefusal(access: AgentAccess): string | null {
  if (access === 'off') return 'The resolution agent is turned off.';
  if (access === 'locked') return 'The Conversational agent is part of Pro.';
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(formData: FormData): Promise<Context> {
  const posted = String(formData.get('ticketId') ?? '');
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  // A malformed id is answered like an unknown one, not with a database error.
  if (!UUID.test(posted)) redirect('/');

  const ticket = await getTicket(tenant.tenant_id, posted);
  if (!ticket) redirect('/');

  return {
    userId: user.id,
    tenantId: tenant.tenant_id,
    ticketId: ticket.id,
    agent: await agentAccess(user, tenant.tenant_id),
  };
}

/** A failure the reviewer can act on, as opposed to a bug. Its message is shown as-is. */
class SendError extends Error {}

export async function sendAgentMessage(
  _previous: SendState,
  formData: FormData
): Promise<SendState> {
  const ctx = await context(formData);
  const flagId = String(formData.get('flagId') ?? '');

  try {
    const refusal = agentRefusal(ctx.agent);
    if (refusal) throw new SendError(refusal);
    if (!(await agentTablesAvailable())) {
      throw new SendError('The resolution agent needs database migration 0008 first.');
    }

    const message = normalizeAgentMessage(formData.get('message'));
    if (!message.ok) throw new SendError(message.error);

    const { ticket, version, flag } = await loadOpenFlag(ctx, flagId);

    if (await isOverTokenCap(ctx.tenantId)) {
      throw new SendError(
        'This workspace is over its monthly token cap, so the agent is paused until the cap resets. You can still decide flags on the Review tab.'
      );
    }

    const conversation = await startAgentConversation(ctx.tenantId, {
      ticketId: ctx.ticketId,
      ticketVersionId: version.id,
      userId: ctx.userId,
    });

    let settings: ReturnType<typeof agentSettings>;
    try {
      settings = agentSettings();
    } catch (error) {
      throw new SendError(describeModelFailure(error));
    }
    const spent = await agentConversationCost(ctx.tenantId, conversation.id);
    if (spent >= settings.costCeilingUsd) {
      throw new SendError(
        `This conversation has reached its cost ceiling ($${settings.costCeilingUsd.toFixed(2)}), so the agent stops here. Decide the remaining flags on the Review tab.`
      );
    }

    // A claim is only treated as abandoned once it has outlived any legitimate turn.
    const staleAfterMs = agentTurnDeadlineMs(settings) + 15_000;
    const claim = await claimAgentTurn(ctx.tenantId, conversation.id, ctx.userId, staleAfterMs);
    if (!claim) {
      throw new SendError(
        'The agent is still answering your previous message. Wait for it, then send again.'
      );
    }

    try {
      const history = (await listAgentMessages(ctx.tenantId, conversation.id)).filter(
        (m) => m.flag_id === flag.id && m.kind !== 'decision'
      );
      const agentFlag = toAgentFlag(flag);
      const opener = history.some((m) => m.kind === 'question') ? null : openingQuestion(agentFlag);

      let outcome: Awaited<ReturnType<typeof agentTurn>>;
      try {
        outcome = await agentTurn({
          ticket: {
            externalKey: ticket.external_key,
            title: version.title,
            descriptionText: version.description_text,
            acceptanceCriteriaText: version.acceptance_criteria_text,
          },
          flag: agentFlag,
          history: [
            ...(opener ? [{ role: 'agent' as const, content: opener }] : []),
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
          message: message.text,
        });
      } catch (error) {
        // Billed attempts are logged even when the turn failed (schema or transport).
        const calls = callsFromError(error).map(toCallInput);
        await recordFailedAgentTurn(ctx.tenantId, conversation.id, claim, calls);
        throw new SendError(describeModelFailure(error));
      }

      try {
        await recordAgentTurn(ctx.tenantId, {
          conversationId: conversation.id,
          claimToken: claim,
          flagId: flag.id,
          userId: ctx.userId,
          opener,
          pmMessage: message.text,
          reply: outcome.reply,
          proposal: outcome.proposal,
          calls: outcome.calls.map(toCallInput),
        });
      } catch (error) {
        // The reply was not saved (its claim was taken over, or the write failed), but the
        // model call was made and billed: log it so spend and the cost ceiling stay true.
        await recordFailedAgentTurn(
          ctx.tenantId,
          conversation.id,
          claim,
          outcome.calls.map(toCallInput)
        ).catch((logError: unknown) =>
          console.error('[conversation] could not log a refused turn', logError)
        );
        throw error;
      }
    } catch (error) {
      // Covers a failure after the claim that was not already released (e.g. the DB
      // write). Releasing twice is harmless, and only ever releases this turn's claim.
      await releaseAgentTurn(ctx.tenantId, conversation.id, claim).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof SendError || error instanceof AgentConversationError) {
      return { status: 'error', error: error.message };
    }
    console.error('[conversation] send failed', error);
    return {
      status: 'error',
      error:
        'Something went wrong saving that message. Try again, or decide this flag on the Review tab.',
    };
  }

  revalidatePath(`/tickets/${ctx.ticketId}/conversation`);
  return { status: 'sent', sentAt: Date.now() };
}

/**
 * Apply the agent's draft — the human gate. The decision itself comes from the stored
 * draft; the reviewer may change the wording before applying.
 */
export async function applyProposalAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const conversationId = String(formData.get('conversationId') ?? '');
  const messageId = String(formData.get('messageId') ?? '');
  const flagId = String(formData.get('flagId') ?? '');
  const editedQuestion = formData.get('editedQuestion');
  const resolutionNote = formData.get('resolutionNote');

  await settle(ctx.ticketId, flagId, async () => {
    const refusal = agentRefusal(ctx.agent);
    if (refusal) throw new AgentConversationError(refusal);
    await applyAgentProposal(ctx.tenantId, {
      conversationId,
      messageId,
      userId: ctx.userId,
      editedQuestion: typeof editedQuestion === 'string' ? editedQuestion : undefined,
      resolutionNote: typeof resolutionNote === 'string' ? resolutionNote : undefined,
    });
    // The decided flag is no longer the one to show; let the page pick the next open one.
    return null;
  });
}

/** Set a draft aside and keep talking. */
export async function declineProposalAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const conversationId = String(formData.get('conversationId') ?? '');
  const messageId = String(formData.get('messageId') ?? '');
  const flagId = String(formData.get('flagId') ?? '');

  await settle(ctx.ticketId, flagId, async () => {
    const refusal = agentRefusal(ctx.agent);
    if (refusal) throw new AgentConversationError(refusal);
    await declineAgentProposal(ctx.tenantId, { conversationId, messageId, userId: ctx.userId });
    return flagId;
  });
}

/**
 * The open flag a message is about, on the current version — after checking the
 * blind-first gate. `revealedFlags` refuses before the reviewer's gap list is locked,
 * and this is checked before any flag is read, mirroring the Review page.
 */
async function loadOpenFlag(ctx: Context, flagId: string) {
  const ticket = await getTicket(ctx.tenantId, ctx.ticketId);
  if (!ticket) throw new SendError('Ticket not found.');
  const version = await latestVersion(ctx.tenantId, ctx.ticketId);
  if (!version) throw new SendError('This ticket has no analyzable version yet.');

  const session = await findSession(ctx.tenantId, version.id, ctx.userId);
  if (!session || session.gaps_locked_at === null) {
    throw new SendError(
      'Lock your own gap list on the Review tab before discussing the model’s flags.'
    );
  }

  const { flags } = await revealedFlags(ctx.tenantId, session.id);
  // Pruned flags were never meant for review; they are not something to discuss.
  const flag = flags.find((f) => f.id === flagId && f.status !== 'pruned');
  if (!flag) throw new SendError('That flag is not on the current version of this ticket.');
  if (flag.status !== 'open') {
    throw new SendError(`This flag is already ${flag.status}. Pick an open flag to keep going.`);
  }
  return { ticket, version, flag };
}

async function settle(
  ticketId: string,
  flagId: string,
  work: () => Promise<string | null>
): Promise<never> {
  let message: string | null = null;
  let nextFlag: string | null = flagId || null;
  try {
    nextFlag = await work();
  } catch (error) {
    // The repositories' own errors are written for the reviewer; anything else is a bug
    // whose raw text (SQL, stack details) does not belong in a URL.
    if (error instanceof AgentConversationError || error instanceof FlagDecisionError) {
      message = error.message;
    } else {
      console.error('[conversation] action failed', error);
      message = 'That did not work. Reload the page and try again.';
    }
  }

  revalidatePath(`/tickets/${ticketId}/conversation`);
  revalidatePath(`/tickets/${ticketId}`);
  const params = new URLSearchParams();
  if (nextFlag) params.set('flag', nextFlag);
  if (message) params.set('error', message);
  const query = params.toString();
  redirect(`/tickets/${ticketId}/conversation${query ? `?${query}` : ''}`);
}

function toAgentFlag(flag: FlagRow): AgentFlag {
  return {
    category: flag.category,
    severity: flag.severity,
    quotedSpan: flag.quoted_span,
    whatUnclear: flag.what_unclear,
    whyItMatters: flag.why_it_matters,
    questionForPm: flag.edited_question ?? flag.question_for_pm,
  };
}

function toCallInput(call: {
  promptVersion: string;
  model: string;
  request: unknown;
  response: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
}): AgentCallInput {
  return {
    purpose: 'agent_turn',
    promptVersion: call.promptVersion,
    model: call.model,
    request: call.request,
    response: call.response,
    latencyMs: call.latencyMs,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    costUsd: call.costUsd,
    error: call.error,
  };
}

/**
 * What the reviewer is told when the model call fails. Specific enough to act on, and
 * nothing from the server's configuration or the provider's raw error.
 */
function describeModelFailure(error: unknown): string {
  console.error('[conversation] agent turn failed', error);
  if (error instanceof SchemaValidationError) {
    return 'The agent’s reply came back in a form SpecFix could not read. Your message was not saved — send it again, or rephrase it.';
  }
  const name = error instanceof Error ? error.name : '';
  const status = (error as { status?: number }).status;
  if (/timeout/i.test(name) || /timed out/i.test(String((error as Error)?.message ?? ''))) {
    return 'The agent took too long to answer. Your message was not saved — send it again.';
  }
  if (status === 429) {
    return 'The AI service is rate-limiting requests right now. Wait a moment, then send your message again.';
  }
  if (error instanceof Error && error.message.startsWith('Invalid configuration')) {
    return 'The AI service is not configured on the server, so the agent cannot answer. Decide this flag on the Review tab.';
  }
  return 'The agent could not answer just now. Your message was not saved — try again, or decide this flag on the Review tab.';
}
