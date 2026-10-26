/**
 * The conversational resolution agent: one turn of a chat about one open flag.
 *
 * Structurally this is the Extractor's shape again (packages/core/src/analyze.ts): render
 * a delimited user message, neutralize every delimiter the data could contain, make one
 * structured call through the shared transport, post-process, return data. No tools, no
 * memory beyond the conversation the caller passes in, no DB. Persistence and the human
 * gate are the caller's job.
 *
 * The Phase 2 plan names LangGraph for this milestone. It is not used: the flow is one
 * structured call per PM message over a fixed state (ticket, flag, transcript), with no
 * branching tool use for a graph runtime to orchestrate, and a new framework would bring
 * its own retry and logging path beside the one every other pass shares. If the agent
 * ever gains tools, that is the point to revisit it.
 *
 * Rules enforced here rather than asked for in the prompt, because each is a way the
 * agent could quietly overstep:
 *
 *  1. A proposal is only kept on a turn where the PM said something. The opening
 *     question is deterministic (`openingQuestion`) and never calls the model, so the
 *     model cannot propose before the PM has spoken.
 *  2. An `edited` proposal with no rewritten question is dropped, as is an `accepted`
 *     one with no resolution — `decideFlag` would refuse the first, and the second
 *     would record a resolution with nothing in it.
 *  3. Fields that do not apply to the decision are cleared, so a dismissal cannot smuggle
 *     a rewritten question into the audit trail.
 */
import { AgentTurnResultSchema, type AgentProposal, type AnalyzableTicket } from '@specfix/shared';
import {
  TICKET_CLOSE,
  TICKET_OPEN,
  callForSchema,
  getConfig,
  loadPromptFrom,
  neutralizeDelimiters,
  renderTicket,
  type LlmCallRecord,
} from '@specfix/core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agentResponseFormat } from './schema.ts';

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export const DEFAULT_AGENT_PROMPT = 'resolve-flag-v1';

const DELIMITER_TAGS = ['ticket', 'flag', 'conversation'] as const;

/**
 * Turns of history sent with each call. The flag and the ticket are the context; a
 * long transcript mostly re-sends the same back-and-forth, and every turn pays for it.
 */
export const HISTORY_TURNS = 12;

/** The flag under discussion, as the agent sees it. Data, never instructions. */
export interface AgentFlag {
  category: string;
  severity: string;
  quotedSpan: string;
  whatUnclear: string;
  whyItMatters: string;
  /** Carries any reviewer edit already made to the question. */
  questionForPm: string;
}

export interface AgentHistoryEntry {
  role: 'pm' | 'agent';
  content: string;
}

export interface AgentTurnInput {
  ticket: AnalyzableTicket;
  flag: AgentFlag;
  /** Earlier messages about this flag, oldest first, not including `message`. */
  history: readonly AgentHistoryEntry[];
  /** The PM's new message, already normalized (see normalizeAgentMessage). */
  message: string;
}

export interface AgentTurnMeta {
  promptVersion: string;
  model: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Why the model's proposal was discarded by rule 2, or null. */
  proposalDropped: string | null;
  /** Earlier turns left out of the request by the HISTORY_TURNS window. */
  historyOmitted: number;
}

export interface AgentTurnOutcome {
  reply: string;
  proposal: AgentProposal | null;
  meta: AgentTurnMeta;
  calls: LlmCallRecord[];
}

export interface AgentTurnOptions {
  promptName?: string;
  model?: string;
  timeoutMs?: number;
  maxTransportRetries?: number;
}

/**
 * The agent's limits, from the environment. Separate model id so agent spend can be
 * moved independently; the timeout and retry count are short because a person is
 * waiting on the reply.
 */
export function agentSettings(): {
  model: string;
  timeoutMs: number;
  maxTransportRetries: number;
  costCeilingUsd: number;
} {
  const config = getConfig();
  return {
    model: process.env.OPENAI_MODEL_AGENT?.trim() || config.modelJudge,
    timeoutMs: positive(process.env.AGENT_TIMEOUT_MS, 30_000),
    maxTransportRetries: nonNegative(process.env.AGENT_MAX_RETRIES, 1),
    costCeilingUsd: positive(process.env.AGENT_COST_CEILING_USD, 0.25),
  };
}

/**
 * The longest one turn can legitimately run: every HTTP attempt timing out, plus backoff.
 * A turn makes up to (retries + 1) attempts for the first response and as many again for
 * the one schema repair, so the turn claim must not be treated as stale before this.
 */
export function agentTurnDeadlineMs(
  settings: Pick<ReturnType<typeof agentSettings>, 'timeoutMs' | 'maxTransportRetries'>
): number {
  const attempts = (settings.maxTransportRetries + 1) * 2;
  // Backoff before retry n is 500ms * 2^(n-1), up to +25% jitter (core/openai.ts).
  const backoffPerLoop = 500 * (2 ** settings.maxTransportRetries - 1) * 1.25;
  return attempts * settings.timeoutMs + 2 * backoffPerLoop;
}

/**
 * The agent's first message about a flag. Deterministic on purpose: it is the flag's own
 * question, so opening a conversation costs nothing and cannot carry a proposal.
 */
export function openingQuestion(flag: AgentFlag): string {
  const span = flag.quotedSpan.trim();
  // A quote that already ends a sentence takes no second full stop after it.
  const quoted = span ? ` The ticket says “${span}”${/[.!?]$/.test(span) ? '' : '.'}` : '';
  return `${flag.whatUnclear.trim()}${quoted} ${flag.questionForPm.trim()}`.trim();
}

export async function agentTurn(
  input: AgentTurnInput,
  options: AgentTurnOptions = {}
): Promise<AgentTurnOutcome> {
  const config = getConfig();
  const settings = agentSettings();
  const prompt = await loadPromptFrom(promptsDir, options.promptName ?? DEFAULT_AGENT_PROMPT);
  const model = options.model ?? settings.model;

  const rendered = renderAgentMessage(input, config.maxTicketInputTokens);

  const { result, calls } = await callForSchema(
    {
      purpose: 'agent_turn',
      promptVersion: prompt.version,
      model,
      systemMessage: prompt.systemMessage,
      userMessage: rendered.userMessage,
      timeoutMs: options.timeoutMs ?? settings.timeoutMs,
      maxTransportRetries: options.maxTransportRetries ?? settings.maxTransportRetries,
    },
    AgentTurnResultSchema,
    agentResponseFormat()
  );

  const { proposal, dropped } = sanitizeProposal(result.proposal);

  return {
    reply: result.reply.trim(),
    proposal,
    calls,
    meta: {
      promptVersion: prompt.version,
      model: calls.at(-1)?.model ?? model,
      attempts: calls.length,
      inputTokens: sum(calls, (c) => c.inputTokens),
      outputTokens: sum(calls, (c) => c.outputTokens),
      costUsd: sum(calls, (c) => c.costUsd),
      latencyMs: sum(calls, (c) => c.latencyMs),
      proposalDropped: dropped,
      historyOmitted: rendered.historyOmitted,
    },
  };
}

/**
 * Builds the delimited user message: ticket, flag, conversation.
 *
 * Every block is neutralized against all three tags. The ticket is the obvious carrier
 * of an injected `</ticket>`, but the flag is model output derived from the ticket and
 * the PM's own text is free input — any of them could close a block early.
 */
export function renderAgentMessage(
  input: AgentTurnInput,
  maxTicketTokens: number
): { userMessage: string; historyOmitted: number } {
  const safe = (text: string): string => neutralizeDelimiters(text, DELIMITER_TAGS);

  const ticketBody = renderTicket(input.ticket, maxTicketTokens).body;

  const flagBlock = [
    `Category: ${input.flag.category}`,
    `Severity: ${input.flag.severity}`,
    `Quoted words: ${input.flag.quotedSpan.trim() || '(none — the gap is an absence)'}`,
    `What is unclear: ${input.flag.whatUnclear}`,
    `Why it matters: ${input.flag.whyItMatters}`,
    `Question for the PM: ${input.flag.questionForPm}`,
  ].join('\n');

  const window = input.history.slice(-HISTORY_TURNS);
  const transcript = [...window, { role: 'pm' as const, content: input.message }]
    .map((entry) => `${entry.role === 'pm' ? 'PM' : 'Agent'}: ${oneParagraph(entry.content)}`)
    .join('\n');

  return {
    userMessage: [
      TICKET_OPEN,
      safe(ticketBody),
      TICKET_CLOSE,
      '',
      '<flag>',
      safe(flagBlock),
      '</flag>',
      '',
      '<conversation>',
      safe(transcript),
      '</conversation>',
    ].join('\n'),
    historyOmitted: input.history.length - window.length,
  };
}

/** Rules 2 and 3. Returns the proposal to keep, or null with the reason it was dropped. */
export function sanitizeProposal(raw: AgentProposal | null): {
  proposal: AgentProposal | null;
  dropped: string | null;
} {
  if (!raw) return { proposal: null, dropped: null };

  const editedQuestion = raw.edited_question.trim();
  const resolutionNote = raw.resolution_note.trim();

  if (raw.decision === 'edited' && editedQuestion === '') {
    return { proposal: null, dropped: 'edited proposal had no rewritten question' };
  }
  if (raw.decision === 'accepted' && resolutionNote === '') {
    return { proposal: null, dropped: 'accepted proposal had no resolution' };
  }

  return {
    proposal: {
      decision: raw.decision,
      edited_question: raw.decision === 'edited' ? editedQuestion : '',
      resolution_note: resolutionNote,
    },
    dropped: null,
  };
}

/**
 * One transcript line per message. A PM's line break could otherwise start a new line
 * reading `Agent: …` and put words in the agent's mouth.
 */
function oneParagraph(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' / ').trim();
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegative(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
