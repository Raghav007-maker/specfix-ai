/**
 * The two-pass deliberation pipeline: Extractor, then Critic.
 *
 * Pass 1 is `analyzeTicket` unchanged — the same prompt and the same code path the
 * single-shot baseline uses. That is deliberate and load-bearing for the ablation:
 * if the Extractor differed from the baseline, a precision change could come from
 * either the new extraction or the Critic, and the experiment would answer neither
 * question. The only variable between the two arms is whether pass 2 runs.
 *
 * Pass 2 shows the Critic the ticket and the candidates and takes a keep/prune
 * verdict on each.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE RETURNS THE PRUNED FLAGS
 *
 * Pruning raises precision mechanically. Discard the doubtful half of any flag list
 * and the remainder scores better — a shredder achieves it without reading
 * anything. So the surviving flags alone cannot show that the Critic works.
 *
 * What can show it is the counterfactual: the same candidate list, the same number
 * of flags removed, chosen at random. The Critic has to beat that. Computing it
 * needs the flags the Critic threw away and the reviewer verdicts on them, so
 * `pruned` is part of the return value and is carried all the way into the eval
 * report. See packages/eval/src/control.ts.
 *
 * Deleting `pruned` to tidy up would silently turn the experiment back into one
 * that cannot fail.
 * ---------------------------------------------------------------------------
 *
 * Four safety rules are enforced here rather than asked for in the prompt, because
 * each one is a way the measurement could quietly break:
 *
 *  1. A candidate the Critic did not review is KEPT. Silent drops inflate precision
 *     and would make a truncated or malformed Critic response look like good
 *     judgment. Unreviewed candidates are counted and reported.
 *  2. The Critic cannot change `category` or `quoted_span`. Those are the
 *     Extractor's grounding in the ticket text. Only the question wording and
 *     severity are taken from the Critic.
 *  3. A kept candidate whose refined question came back empty falls back to the
 *     Extractor's question. An empty question is not a flag a reviewer can act on.
 *  4. Both passes use the same model by default. Running the Extractor on one model
 *     and the Critic on a larger one confounds the ablation — a precision gain
 *     could be the Critic or could just be the better model. When they do differ,
 *     `modelsDiffer` says so and the eval report refuses to treat the run as a
 *     clean comparison.
 */
import {
  CriticResultSchema,
  type CriticReview,
  type AnalyzableTicket,
  type Severity,
} from '@specfix/shared';
import { getConfig } from './config.ts';
import { loadPrompt } from './prompt.ts';
import {
  analyzeTicket,
  neutralizeDelimiters,
  DEFAULT_PROMPT,
  TICKET_CLOSE,
  TICKET_OPEN,
  type AnalyzedFlag,
} from './analyze.ts';
import { callForCritique, type LlmCallRecord } from './openai.ts';

export const DEFAULT_EXTRACTOR_PROMPT = DEFAULT_PROMPT;
export const DEFAULT_CRITIC_PROMPT = 'critic-v1';

const CANDIDATES_OPEN = '<candidates>';
const CANDIDATES_CLOSE = '</candidates>';
const DELIMITER_TAGS = ['ticket', 'candidates'] as const;

/** A candidate the Critic kept, with the Critic's refinements applied. */
export interface ApprovedFlag extends AnalyzedFlag {
  criticVerdict: 'keep';
  criticReason: string;
  /** The Extractor's wording, retained so a refinement can be reviewed rather than trusted. */
  originalQuestion: string;
  originalSeverity: Severity;
  questionRefined: boolean;
  severityChanged: boolean;
  /** False when the Critic returned no verdict for this candidate and rule 1 kept it. */
  criticReviewed: boolean;
}

/** A candidate the Critic dropped. Retained for the control arm and the audit log. */
export interface PrunedFlag extends AnalyzedFlag {
  criticVerdict: 'prune';
  criticReason: string;
}

export interface DeliberationMeta {
  extractorPromptVersion: string;
  criticPromptVersion: string;
  /** Composite identity. A report cannot be attributed to the wrong pair of prompts. */
  promptVersion: string;
  extractorModel: string;
  criticModel: string;
  /** The Extractor's model, reported as the run's model when both passes agree. */
  model: string;
  /** True when the two passes ran on different models, which confounds the ablation. */
  modelsDiffer: boolean;
  temperature: number;
  seed: number | null;
  truncated: boolean;
  candidatesProduced: number;
  approvedCount: number;
  prunedCount: number;
  /** Candidates the Critic returned no verdict for. Kept by rule 1. */
  unreviewedCandidates: number;
  /** Second and later verdicts for one index. First wins. */
  duplicateReviews: number;
  /** Verdicts for indices that were never sent. Ignored. */
  outOfRangeReviews: number;
  /** True when the Extractor found nothing, so the Critic call was skipped. */
  criticSkipped: boolean;
  questionsRefined: number;
  severitiesChanged: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  duplicatesDropped: number;
  unverifiedSpans: number;
}

export interface DeliberationOutcome {
  /** Everything the Extractor produced, before the Critic saw it. */
  candidates: AnalyzedFlag[];
  approved: ApprovedFlag[];
  pruned: PrunedFlag[];
  meta: DeliberationMeta;
  calls: LlmCallRecord[];
}

export interface DeliberateOptions {
  extractorPrompt?: string;
  criticPrompt?: string;
  /** Applies to both passes unless `criticModel` overrides the second. */
  model?: string;
  /**
   * Overrides the model for the Critic pass only. Setting this confounds the
   * ablation on purpose — it exists for the "does a bigger critic help?" follow-up
   * study, and the run is marked `modelsDiffer` when it is used.
   */
  criticModel?: string;
}

export async function deliberate(
  ticket: AnalyzableTicket,
  options: DeliberateOptions = {}
): Promise<DeliberationOutcome> {
  const config = getConfig();
  const extraction = await analyzeTicket(ticket, {
    purpose: 'extract',
    promptName: options.extractorPrompt ?? DEFAULT_EXTRACTOR_PROMPT,
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  const criticPrompt = await loadPrompt(options.criticPrompt ?? DEFAULT_CRITIC_PROMPT);
  const criticModel = options.criticModel ?? options.model ?? config.modelJudge;
  const candidates = extraction.flags;

  const base = {
    extractorPromptVersion: extraction.meta.promptVersion,
    criticPromptVersion: criticPrompt.version,
    promptVersion: `${extraction.meta.promptVersion}+${criticPrompt.version}`,
    extractorModel: extraction.meta.model,
    criticModel,
    model: extraction.meta.model,
    modelsDiffer: extraction.meta.model !== criticModel,
    temperature: extraction.meta.temperature,
    seed: extraction.meta.seed,
    truncated: extraction.meta.truncated,
    candidatesProduced: candidates.length,
    duplicatesDropped: extraction.meta.duplicatesDropped,
    unverifiedSpans: extraction.meta.unverifiedSpans,
  };

  // Nothing to critique. Skipping the call is not just a saving: an empty candidate
  // list has no verdicts to return, so the call could only add a failure mode.
  if (candidates.length === 0) {
    return {
      candidates,
      approved: [],
      pruned: [],
      calls: extraction.calls,
      meta: {
        ...base,
        approvedCount: 0,
        prunedCount: 0,
        unreviewedCandidates: 0,
        duplicateReviews: 0,
        outOfRangeReviews: 0,
        criticSkipped: true,
        questionsRefined: 0,
        severitiesChanged: 0,
        attempts: extraction.meta.attempts,
        inputTokens: extraction.meta.inputTokens,
        outputTokens: extraction.meta.outputTokens,
        costUsd: extraction.meta.costUsd,
        latencyMs: extraction.meta.latencyMs,
      },
    };
  }

  const { result, calls: criticCalls } = await callForCritique({
    purpose: 'critic',
    promptVersion: criticPrompt.version,
    model: criticModel,
    systemMessage: criticPrompt.systemMessage,
    userMessage: renderCriticMessage(extraction.renderedTicketBody, candidates),
  });

  const applied = applyReviews(candidates, result.reviews, extraction.renderedTicketBody);
  const calls = [...extraction.calls, ...criticCalls];

  return {
    candidates,
    approved: applied.approved,
    pruned: applied.pruned,
    calls,
    meta: {
      ...base,
      approvedCount: applied.approved.length,
      prunedCount: applied.pruned.length,
      unreviewedCandidates: applied.unreviewedCandidates,
      duplicateReviews: applied.duplicateReviews,
      outOfRangeReviews: applied.outOfRangeReviews,
      criticSkipped: false,
      questionsRefined: applied.approved.filter((f) => f.questionRefined).length,
      severitiesChanged: applied.approved.filter((f) => f.severityChanged).length,
      attempts: calls.length,
      inputTokens: sum(calls, (c) => c.inputTokens),
      outputTokens: sum(calls, (c) => c.outputTokens),
      costUsd: sum(calls, (c) => c.costUsd),
      latencyMs: sum(calls, (c) => c.latencyMs),
    },
  };
}

/**
 * The Critic's user message: the ticket, then the candidates as indexed JSON.
 *
 * Both blocks are neutralized against both delimiters. The ticket body arrives
 * already neutralized against `<ticket>` from the Extractor pass; the candidate text
 * is model output derived from the ticket, so it can carry an injected
 * `</candidates>` just as easily.
 */
export function renderCriticMessage(
  ticketBody: string,
  candidates: readonly AnalyzedFlag[]
): string {
  const payload = candidates.map((flag, index) => ({
    index,
    category: flag.category,
    quoted_span: flag.quoted_span,
    what_unclear: flag.what_unclear,
    why_it_matters: flag.why_it_matters,
    question_for_pm: flag.question_for_pm,
    severity: flag.severity,
  }));

  const safeTicket = neutralizeDelimiters(ticketBody, DELIMITER_TAGS);
  const safeCandidates = neutralizeDelimiters(JSON.stringify(payload, null, 2), DELIMITER_TAGS);

  return [
    TICKET_OPEN,
    safeTicket,
    TICKET_CLOSE,
    '',
    CANDIDATES_OPEN,
    safeCandidates,
    CANDIDATES_CLOSE,
  ].join('\n');
}

interface AppliedReviews {
  approved: ApprovedFlag[];
  pruned: PrunedFlag[];
  unreviewedCandidates: number;
  duplicateReviews: number;
  outOfRangeReviews: number;
}

/**
 * Joins verdicts back onto candidates by index.
 *
 * Order is preserved from the candidate list, not from the review list, so a model
 * that returns reviews shuffled cannot reorder the flags a reviewer sees.
 */
export function applyReviews(
  candidates: readonly AnalyzedFlag[],
  reviews: readonly CriticReview[],
  ticketBody: string
): AppliedReviews {
  const byIndex = new Map<number, CriticReview>();
  let duplicateReviews = 0;
  let outOfRangeReviews = 0;

  for (const review of reviews) {
    if (review.candidate_index < 0 || review.candidate_index >= candidates.length) {
      outOfRangeReviews += 1;
      continue;
    }
    if (byIndex.has(review.candidate_index)) {
      duplicateReviews += 1;
      continue;
    }
    byIndex.set(review.candidate_index, review);
  }

  const approved: ApprovedFlag[] = [];
  const pruned: PrunedFlag[] = [];
  let unreviewedCandidates = 0;

  candidates.forEach((candidate, index) => {
    const review = byIndex.get(index);

    // Rule 1. No verdict means keep, not drop.
    if (!review) {
      unreviewedCandidates += 1;
      approved.push({
        ...candidate,
        criticVerdict: 'keep',
        criticReason: 'No verdict returned for this candidate; kept unreviewed.',
        originalQuestion: candidate.question_for_pm,
        originalSeverity: candidate.severity,
        questionRefined: false,
        severityChanged: false,
        criticReviewed: false,
      });
      return;
    }

    if (review.verdict === 'prune') {
      pruned.push({
        ...candidate,
        criticVerdict: 'prune',
        criticReason: review.reason,
      });
      return;
    }

    // Rule 3. An empty refinement falls back rather than shipping a blank question.
    const refined = review.refined_question_for_pm.trim();
    const question = refined === '' ? candidate.question_for_pm : refined;

    // Rule 2. category and quoted_span come from `candidate` and are not overridable;
    // spreading the candidate first and naming only these fields is what enforces it.
    approved.push({
      ...candidate,
      question_for_pm: question,
      severity: review.refined_severity,
      criticVerdict: 'keep',
      criticReason: review.reason,
      originalQuestion: candidate.question_for_pm,
      originalSeverity: candidate.severity,
      questionRefined: question !== candidate.question_for_pm,
      severityChanged: review.refined_severity !== candidate.severity,
      criticReviewed: true,
      // Re-assert grounding. The span was verified against this same body during
      // extraction, so this can only fail if a caller passed a different ticket.
      spanVerified: candidate.quoted_span === '' || ticketBody.includes(candidate.quoted_span),
    });
  });

  return { approved, pruned, unreviewedCandidates, duplicateReviews, outOfRangeReviews };
}

/** Re-exported so callers validating a stored Critic payload do not reach into shared. */
export { CriticResultSchema };

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
