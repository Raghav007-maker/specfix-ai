/**
 * The analysis entry point.
 *
 * Responsibilities beyond making the call:
 *  - render the ticket into a delimited user message, neutralizing any delimiter
 *    the ticket text itself contains
 *  - enforce the input ceiling, and mark the run when it truncates
 *  - drop duplicate flags
 *  - verify each quoted_span actually occurs in the ticket, so the dashboard never
 *    highlights text that does not exist
 *
 * It returns data only. Persistence is the caller's job — core does not import db.
 */
import { flagDedupeKey, type AnalyzableTicket, type LlmFlag } from '@specfix/shared';
import { getConfig } from './config.ts';
import { loadPrompt } from './prompt.ts';
import { estimateTokens } from './cost.ts';
import { callForAnalysis, type LlmCallRecord } from './openai.ts';

export const DEFAULT_PROMPT = 'single-shot-v1';

export const TICKET_OPEN = '<ticket>';
export const TICKET_CLOSE = '</ticket>';
const TRUNCATION_MARKER = '\n\n[... description truncated for length ...]';

export interface AnalyzedFlag extends LlmFlag {
  dedupeKey: string;
  /** False when quoted_span did not occur verbatim in the ticket and was cleared. */
  spanVerified: boolean;
}

export interface AnalysisMeta {
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  truncated: boolean;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  duplicatesDropped: number;
  unverifiedSpans: number;
}

export interface AnalyzeOutcome {
  flags: AnalyzedFlag[];
  meta: AnalysisMeta;
  calls: LlmCallRecord[];
  /**
   * The ticket block as the model saw it, without delimiters. The Critic pass
   * re-verifies quoted spans against this exact string, so it must be the same text
   * the Extractor was given, not a re-render.
   */
  renderedTicketBody: string;
}

export interface AnalyzeOptions {
  promptName?: string;
  /** Overrides OPENAI_MODEL_JUDGE for this call. */
  model?: string;
  /**
   * How this call is recorded in llm_calls. Defaults to `single_shot`; the
   * deliberation pipeline passes `extract` so the two arms of the ablation are
   * distinguishable in the cost and latency breakdown.
   */
  purpose?: LlmCallRecord['purpose'];
}

export async function analyzeTicket(
  ticket: AnalyzableTicket,
  options: AnalyzeOptions = {}
): Promise<AnalyzeOutcome> {
  const config = getConfig();
  const prompt = await loadPrompt(options.promptName ?? DEFAULT_PROMPT);
  const model = options.model ?? config.modelJudge;

  const rendered = renderTicket(ticket, config.maxTicketInputTokens);

  const { result, calls } = await callForAnalysis({
    purpose: options.purpose ?? 'single_shot',
    promptVersion: prompt.version,
    model,
    systemMessage: prompt.systemMessage,
    userMessage: rendered.userMessage,
  });

  const { flags, duplicatesDropped, unverifiedSpans } = postProcess(result.flags, rendered.body);

  return {
    flags,
    meta: {
      promptVersion: prompt.version,
      model: calls.at(-1)?.model ?? model,
      temperature: config.temperature,
      seed: config.seed,
      truncated: rendered.truncated,
      attempts: calls.length,
      inputTokens: sum(calls, (c) => c.inputTokens),
      outputTokens: sum(calls, (c) => c.outputTokens),
      costUsd: sum(calls, (c) => c.costUsd),
      latencyMs: sum(calls, (c) => c.latencyMs),
      duplicatesDropped,
      unverifiedSpans,
    },
    calls,
    renderedTicketBody: rendered.body,
  };
}

interface RenderedTicket {
  userMessage: string;
  /** The ticket block without delimiters, used to verify quoted spans. */
  body: string;
  truncated: boolean;
}

/**
 * Replaces delimiter tags occurring in text that will be placed inside those
 * delimiters.
 *
 * Without this, a ticket can close the delimiter early and everything after it
 * reads as if it came from outside the data block — which is exactly the attack in
 * fixtures/tickets/adversarial/injection-02-delimiter-escape.md.
 *
 * `tags` is explicit rather than a fixed list because the Critic pass wraps two
 * blocks, `<ticket>` and `<candidates>`, and each block has to neutralize both.
 */
export function neutralizeDelimiters(text: string, tags: readonly string[]): string {
  return tags.reduce(
    (out, tag) => out.replace(new RegExp(`<\\/?\\s*${tag}\\s*>`, 'gi'), '[delimiter removed]'),
    text
  );
}

/**
 * Builds the delimited user message.
 *
 * Any `<ticket>` or `</ticket>` occurring in the ticket text is replaced before
 * wrapping.
 */
export function renderTicket(ticket: AnalyzableTicket, maxTokens: number): RenderedTicket {
  const neutralize = (text: string): string => neutralizeDelimiters(text, ['ticket']);

  const title = neutralize(ticket.title);
  const acceptanceCriteria = neutralize(ticket.acceptanceCriteriaText);
  let description = neutralize(ticket.descriptionText);

  const build = (desc: string): string =>
    [
      `Key: ${neutralize(ticket.externalKey)}`,
      `Title: ${title}`,
      '',
      'Description:',
      desc || '(none provided)',
      '',
      'Acceptance criteria:',
      acceptanceCriteria || '(none provided)',
    ].join('\n');

  let truncated = false;
  let body = build(description);

  if (estimateTokens(body) > maxTokens) {
    truncated = true;
    // Title and acceptance criteria are kept whole; the description is what gets
    // cut, since it is where the bulk sits and the AC is what most flags attach to.
    const overheadTokens = estimateTokens(build(''));
    const budgetChars = Math.max(0, (maxTokens - overheadTokens) * 4 - TRUNCATION_MARKER.length);
    description = description.slice(0, budgetChars) + TRUNCATION_MARKER;
    body = build(description);
  }

  return {
    userMessage: `${TICKET_OPEN}\n${body}\n${TICKET_CLOSE}`,
    body,
    truncated,
  };
}

function postProcess(
  raw: LlmFlag[],
  ticketBody: string
): { flags: AnalyzedFlag[]; duplicatesDropped: number; unverifiedSpans: number } {
  const seen = new Set<string>();
  const flags: AnalyzedFlag[] = [];
  let duplicatesDropped = 0;
  let unverifiedSpans = 0;

  for (const flag of raw) {
    const dedupeKey = flagDedupeKey(flag.category, flag.what_unclear);
    if (seen.has(dedupeKey)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(dedupeKey);

    const span = flag.quoted_span.trim();
    const spanVerified = span === '' || ticketBody.includes(span);
    if (!spanVerified) unverifiedSpans += 1;

    flags.push({
      ...flag,
      // Clear an unverifiable span rather than passing a hallucinated quote to the
      // UI, which would try to highlight it and fail.
      quoted_span: spanVerified ? flag.quoted_span : '',
      dedupeKey,
      spanVerified,
    });
  }

  return { flags, duplicatesDropped, unverifiedSpans };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
