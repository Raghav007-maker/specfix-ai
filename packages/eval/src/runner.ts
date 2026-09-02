/**
 * Runs a prompt over the tickets named by a gold set.
 *
 * Deliberately dumb about scoring — it produces flags and hands them to score.ts.
 * The only judgment it makes is that a ticket which fails to analyze is recorded as
 * a failure and carried through to the report, rather than dropped. A run that
 * quietly analyzed 14 of 20 tickets and reported a precision figure would be worse
 * than no number at all.
 */
import { analyzeTicket, type AnalyzeOptions } from '@specfix/core';
import { FileSource } from '@specfix/ingest';
import { toAnalyzable, type NormalizedTicket } from '@specfix/shared';
import type { LoadedGoldSet } from './gold.ts';
import type { TicketRun } from './score.ts';

export interface RunnerOptions {
  gold: LoadedGoldSet;
  promptName: string;
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
  error?: string;
}

export interface RunSummary {
  runs: TicketRun[];
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  /** Wall-clock is not the sum of latencies when running concurrently. */
  latencyMsTotal: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runPrompt(options: RunnerOptions): Promise<RunSummary> {
  const { gold, promptName } = options;
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

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const ticket = selected[index] as NormalizedTicket;

      try {
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

  return { runs: results, ...meta };
}
