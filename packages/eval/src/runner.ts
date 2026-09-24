/**
 * Runs a prompt over the tickets named by a gold set.
 *
 * Deliberately dumb about scoring — it produces flags and hands them to score.ts.
 * The only judgment it makes is that a ticket which fails to analyze is recorded as
 * a failure and carried through to the report, rather than dropped. A run that
 * quietly analyzed 14 of 20 tickets and reported a precision figure would be worse
 * than no number at all.
 *
 * Two arms. `single_shot` calls the Extractor alone; `deliberate` follows it with the
 * Critic. They share this file, and the extractor prompt and model are identical in
 * both, so the only difference between the arms is whether the second pass ran. That
 * is what makes the ablation mean anything: if the arms differed in any other way, a
 * precision change could not be attributed to the Critic.
 */
import {
  analyzeTicket,
  deliberate,
  type AnalyzeOptions,
  type DeliberateOptions,
} from '@specfix/core';
import { FileSource } from '@specfix/ingest';
import { toAnalyzable, type NormalizedTicket } from '@specfix/shared';
import type { LoadedGoldSet } from './gold.ts';
import type { TicketRun } from './score.ts';

/** Which arm of the ablation a run belongs to. Part of the report's identity. */
export type RunArm = 'single_shot' | 'deliberated';

export interface RunnerOptions {
  gold: LoadedGoldSet;
  promptName: string;
  /**
   * `deliberated` runs the Critic after the Extractor. The extractor prompt stays
   * `promptName` in both arms — changing it here would confound the comparison.
   */
  arm?: RunArm;
  /** Critic prompt for the deliberated arm. Ignored by `single_shot`. */
  criticPrompt?: string | undefined;
  model?: string | undefined;
  /** Analyze only the first N tickets in the set. For smoke runs. */
  limit?: number | undefined;
  /** Parallel analyses. Kept low by default; the OpenAI rate limit is shared. */
  concurrency?: number;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
}

export interface ProgressEvent {
  externalId: string;
  index: number;
  total: number;
  flagCount: number;
  /** Candidates the Critic removed. Zero on the single-shot arm. */
  prunedCount?: number;
  error?: string;
}

/** Critic-pass totals across the run. All zero on the single-shot arm. */
export interface DeliberationTotals {
  candidatesProduced: number;
  pruned: number;
  /** Candidates the Critic returned no verdict for, kept by the pipeline's rule 1. */
  unreviewed: number;
  duplicateReviews: number;
  outOfRangeReviews: number;
  questionsRefined: number;
  severitiesChanged: number;
  /**
   * True if any ticket ran the two passes on different models. That confounds the
   * ablation, so the report refuses to call such a run a clean comparison.
   */
  modelsDiffer: boolean;
  criticPromptVersion: string;
}

export interface RunSummary {
  runs: TicketRun[];
  arm: RunArm;
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  /** Wall-clock is not the sum of latencies when running concurrently. */
  latencyMsTotal: number;
  inputTokens: number;
  outputTokens: number;
  /** Present only on the deliberated arm. */
  deliberation?: DeliberationTotals;
}

export async function runPrompt(options: RunnerOptions): Promise<RunSummary> {
  const { gold, promptName } = options;
  const arm: RunArm = options.arm ?? 'single_shot';
  const source = new FileSource({ dir: gold.ticketsDir });
  const available = new Map((await source.list()).map((t) => [t.externalId, t]));

  const wanted = gold.set.tickets.map((t) => t.externalId);
  const missing = wanted.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new Error(
      `gold set names ${missing.length} ticket(s) absent from ${gold.ticketsDir}: ${missing.join(', ')}`
    );
  }

  const selected = (options.limit === undefined ? wanted : wanted.slice(0, options.limit)).map(
    (id) => available.get(id) as NormalizedTicket
  );

  const analyzeOptions: AnalyzeOptions = { promptName };
  if (options.model !== undefined) analyzeOptions.model = options.model;

  const deliberateOptions: DeliberateOptions = { extractorPrompt: promptName };
  if (options.model !== undefined) deliberateOptions.model = options.model;
  if (options.criticPrompt !== undefined) deliberateOptions.criticPrompt = options.criticPrompt;

  const results = new Array<TicketRun>(selected.length);
  const meta = {
    promptVersion: '',
    model: options.model ?? '',
    temperature: 0,
    seed: null as number | null,
    latencyMsTotal: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const totals: DeliberationTotals = {
    candidatesProduced: 0,
    pruned: 0,
    unreviewed: 0,
    duplicateReviews: 0,
    outOfRangeReviews: 0,
    questionsRefined: 0,
    severitiesChanged: 0,
    modelsDiffer: false,
    criticPromptVersion: '',
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const ticket = selected[index] as NormalizedTicket;

      try {
        if (arm === 'deliberated') {
          const outcome = await deliberate(toAnalyzable(ticket), deliberateOptions);
          results[index] = {
            externalId: ticket.externalId,
            flags: outcome.approved,
            prunedFlags: outcome.pruned,
            costUsd: outcome.meta.costUsd,
            truncated: outcome.meta.truncated,
            unverifiedSpans: outcome.meta.unverifiedSpans,
          };
          meta.promptVersion = outcome.meta.promptVersion;
          meta.model = outcome.meta.model;
          meta.temperature = outcome.meta.temperature;
          meta.seed = outcome.meta.seed;
          meta.latencyMsTotal += outcome.meta.latencyMs;
          meta.inputTokens += outcome.meta.inputTokens;
          meta.outputTokens += outcome.meta.outputTokens;

          totals.candidatesProduced += outcome.meta.candidatesProduced;
          totals.pruned += outcome.meta.prunedCount;
          totals.unreviewed += outcome.meta.unreviewedCandidates;
          totals.duplicateReviews += outcome.meta.duplicateReviews;
          totals.outOfRangeReviews += outcome.meta.outOfRangeReviews;
          totals.questionsRefined += outcome.meta.questionsRefined;
          totals.severitiesChanged += outcome.meta.severitiesChanged;
          totals.modelsDiffer = totals.modelsDiffer || outcome.meta.modelsDiffer;
          totals.criticPromptVersion = outcome.meta.criticPromptVersion;

          options.onProgress?.({
            externalId: ticket.externalId,
            index: index + 1,
            total: selected.length,
            flagCount: outcome.approved.length,
            prunedCount: outcome.pruned.length,
          });
          continue;
        }

        const outcome = await analyzeTicket(toAnalyzable(ticket), analyzeOptions);
        results[index] = {
          externalId: ticket.externalId,
          flags: outcome.flags,
          costUsd: outcome.meta.costUsd,
          truncated: outcome.meta.truncated,
          unverifiedSpans: outcome.meta.unverifiedSpans,
        };
        meta.promptVersion = outcome.meta.promptVersion;
        meta.model = outcome.meta.model;
        meta.temperature = outcome.meta.temperature;
        meta.seed = outcome.meta.seed;
        meta.latencyMsTotal += outcome.meta.latencyMs;
        meta.inputTokens += outcome.meta.inputTokens;
        meta.outputTokens += outcome.meta.outputTokens;

        options.onProgress?.({
          externalId: ticket.externalId,
          index: index + 1,
          total: selected.length,
          flagCount: outcome.flags.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[index] = {
          externalId: ticket.externalId,
          flags: [],
          error: message,
          costUsd: 0,
          truncated: false,
          unverifiedSpans: 0,
        };
        options.onProgress?.({
          externalId: ticket.externalId,
          index: index + 1,
          total: selected.length,
          flagCount: 0,
          error: message,
        });
      }
    }
  };

  const lanes = Math.max(1, Math.min(options.concurrency ?? 3, selected.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return {
    runs: results,
    arm,
    ...meta,
    ...(arm === 'deliberated' ? { deliberation: totals } : {}),
  };
}
