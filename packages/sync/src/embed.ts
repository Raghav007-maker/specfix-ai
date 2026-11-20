/**
 * Embeds a spec ticket's new version (the whole requirement and each acceptance-criteria
 * clause), so the Specs tab can suggest which clauses a scenario covers. Cheap, so it runs
 * when a task is sent for spec review rather than waiting for an admin; skipped when there are
 * no OpenAI credentials or the workspace is over its monthly token cap. Every call is logged
 * in llm_calls by the sync functions.
 */
import { embedTextsTolerant, getConfig, hasOpenAiCredentials } from '@specfix/core';
import {
  describeEmbeddingProblem,
  isOverTokenCap,
  syncClauseEmbeddings,
  syncRequirementEmbeddings,
} from '@specfix/db';

/** Returns a problem to log, or null when the versions were embedded (or skipped on purpose). */
export async function embedTicketVersions(
  tenantId: string,
  versionIds: string[]
): Promise<string | null> {
  if (versionIds.length === 0 || !hasOpenAiCredentials()) return null;
  if (await isOverTokenCap(tenantId)) return null;
  const deps = { embed: embedTextsTolerant, model: getConfig().modelEmbed };
  const requirement = await syncRequirementEmbeddings(tenantId, versionIds, deps);
  const clauses = await syncClauseEmbeddings(tenantId, versionIds, deps);
  return describeEmbeddingProblem(requirement) ?? describeEmbeddingProblem(clauses);
}
