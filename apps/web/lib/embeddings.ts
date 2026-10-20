import 'server-only';

/**
 * Embedding refresh for the review actions.
 *
 * The decision logic lives in @specfix/db's `syncScenarioEmbedding`; this module only
 * supplies what the web app owns: the API client (@specfix/core's tolerant embedder,
 * which retries transient failures), the same spend gates the generate action applies,
 * and the server log as the fallback home for call records the database refused.
 *
 * It runs inline, after the decision has committed, because there is no worker yet —
 * the same reason generation runs inline. A failure never undoes the decision.
 */
import { embedTextsTolerant, getConfig, hasOpenAiCredentials } from '@specfix/core';
import { describeEmbeddingProblem, isOverTokenCap, syncScenarioEmbedding } from '@/lib/repos';

/**
 * Refreshes an accepted scenario's vector. Returns null when the vector is current
 * afterwards (or the scenario needs none), otherwise a sentence saying what did not
 * happen and how it recovers, for the caller to surface.
 */
export async function refreshScenarioEmbedding(
  tenantId: string,
  scenarioId: string
): Promise<string | null> {
  if (!hasOpenAiCredentials()) {
    return 'its embedding was not generated: no embedding API key is configured. Run the embedding backfill once one is.';
  }
  // Same gate as generation: past the monthly cap, nothing that spends tokens runs.
  if (await isOverTokenCap(tenantId)) {
    return 'its embedding was not generated: the workspace is over its monthly token cap. Run the embedding backfill after the cap resets.';
  }

  const result = await syncScenarioEmbedding(tenantId, scenarioId, {
    embed: (texts) => embedTextsTolerant(texts),
    model: getConfig().modelEmbed,
  });

  const outcome = result.outcomes[0]?.outcome;
  if (result.callLogError !== null && result.calls.length > 0) {
    // The database refused the call records, so the server log is their only copy.
    console.error(
      '[embeddings] llm_calls insert failed; unlogged embedding calls follow',
      JSON.stringify({ tenantId, scenarioId, error: result.callLogError, calls: result.calls })
    );
  }
  if (outcome?.status === 'failed') {
    console.error('[embeddings] scenario embedding refresh failed', {
      tenantId,
      scenarioId,
      stage: outcome.stage,
      error: outcome.error,
    });
  }

  return describeEmbeddingProblem(result);
}
