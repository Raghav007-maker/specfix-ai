/**
 * analyze_batch: run the analyzer over the ticket versions an admin approved.
 *
 * The job carries the exact version ids chosen when the admin clicked, so nothing joins
 * a batch after approval. Before each ticket it re-checks, in order: that the version
 * has not been analyzed since (a retry or a second batch must not pay twice), that the
 * tenant is under its monthly token cap, and that this batch has not reached its own
 * spending ceiling. Hitting a limit stops the batch cleanly and says which limit it was;
 * the remaining tickets simply qualify again for a later batch.
 *
 * A ticket whose analysis fails is recorded as a failed run with its billable calls, and
 * the batch moves on. Two failures leave a version out of later batches until someone
 * looks (MAX_FAILED_ANALYSES), so a ticket that always breaks cannot drain the budget.
 */
import {
  DEFAULT_PROMPT,
  analyzeTicket,
  callsFromError,
  getConfig,
  type AnalyzeOutcome,
} from '@specfix/core';
import {
  checkpointJob,
  isOverTokenCap,
  notifyTicketEvent,
  recordAnalysis,
  recordFailedAnalysis,
  versionsForAnalysis,
  type JobRow,
} from '@specfix/db';
import type { AnalyzableTicket } from '@specfix/shared';
import { analysisModel, analyzeBatchMaxUsd } from './budget.ts';
import { PermanentJobError } from './errors.ts';

export interface AnalyzeBatchDeps {
  analyze: (ticket: AnalyzableTicket) => Promise<AnalyzeOutcome>;
  overCap: (tenantId: string) => Promise<boolean>;
  modelPriced: () => boolean;
  maxUsd: number;
  /** Tells the people who decide flags that a ticket has new ones. */
  notify: (tenantId: string, ticketId: string, flags: number) => Promise<void>;
}

export interface AnalyzeBatchProgress {
  total: number;
  analyzed: number;
  skipped: number;
  failed: number;
  flags: number;
  costUsd: number;
  stopped: null | 'token_cap' | 'batch_budget';
}

export const defaultAnalyzeBatchDeps = (): AnalyzeBatchDeps => ({
  analyze: (ticket) => analyzeTicket(ticket),
  overCap: isOverTokenCap,
  modelPriced: () => analysisModel().priced,
  maxUsd: analyzeBatchMaxUsd(),
  notify: async (tenantId, ticketId, flags) => {
    await notifyTicketEvent(tenantId, { kind: 'flags_ready', ticketId, details: { flags } });
  },
});

export async function runAnalyzeBatch(
  job: JobRow,
  deps: AnalyzeBatchDeps = defaultAnalyzeBatchDeps()
): Promise<AnalyzeBatchProgress> {
  const tenantId = job.tenant_id;
  if (!deps.modelPriced()) {
    throw new PermanentJobError(
      `Analysis model "${getConfig().modelJudge}" has no known price, so its spend cannot be ` +
        'tracked. Add it to MODEL_PRICING in packages/core/src/cost.ts.'
    );
  }
  const ids = Array.isArray(job.payload.versionIds)
    ? job.payload.versionIds.filter((id): id is string => typeof id === 'string')
    : [];
  const versions = await versionsForAnalysis(tenantId, ids);

  const progress: AnalyzeBatchProgress = {
    total: versions.length,
    analyzed: 0,
    skipped: 0,
    failed: 0,
    flags: 0,
    // A resumed batch (its worker died) keeps what it already spent, so the ceiling still
    // holds; versions it finished show up as skipped.
    costUsd: Number(job.progress.costUsd ?? 0),
    stopped: null,
  };

  for (const version of versions) {
    if (version.analyzed) {
      progress.skipped += 1;
      continue;
    }
    if (await deps.overCap(tenantId)) {
      progress.stopped = 'token_cap';
      break;
    }
    if (progress.costUsd >= deps.maxUsd) {
      progress.stopped = 'batch_budget';
      break;
    }

    const ticket: AnalyzableTicket = {
      externalKey: version.external_key,
      title: version.title,
      descriptionText: version.description_text,
      acceptanceCriteriaText: version.acceptance_criteria_text,
    };
    try {
      const outcome = await deps.analyze(ticket);
      const recorded = await recordAnalysis(tenantId, {
        ticketId: version.ticket_id,
        ticketVersionId: version.ticket_version_id,
        meta: {
          promptVersion: outcome.meta.promptVersion,
          model: outcome.meta.model,
          temperature: outcome.meta.temperature,
          seed: outcome.meta.seed,
          truncated: outcome.meta.truncated,
          inputTokens: outcome.meta.inputTokens,
          outputTokens: outcome.meta.outputTokens,
          costUsd: outcome.meta.costUsd,
        },
        flags: outcome.flags,
        calls: outcome.calls,
      });
      progress.analyzed += 1;
      progress.flags += recorded.flagIds.length;
      if (recorded.flagIds.length > 0) {
        await deps.notify(tenantId, version.ticket_id, recorded.flagIds.length);
      }
      progress.costUsd += outcome.meta.costUsd;
    } catch (error) {
      const calls = callsFromError(error);
      const config = getConfig();
      await recordFailedAnalysis(tenantId, {
        ticketId: version.ticket_id,
        ticketVersionId: version.ticket_version_id,
        promptVersion: calls[0]?.promptVersion ?? DEFAULT_PROMPT,
        model: config.modelJudge,
        temperature: config.temperature,
        seed: config.seed,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
        calls,
      });
      progress.failed += 1;
      progress.costUsd += calls.reduce((sum, c) => sum + c.costUsd, 0);
    }
    await checkpointJob(tenantId, job.id, { progress: { ...progress } });
  }

  return progress;
}
