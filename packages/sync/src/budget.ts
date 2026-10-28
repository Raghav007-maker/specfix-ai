/**
 * The money guards around analysis.
 *
 *   - A batch is at most ANALYZE_BATCH_LIMIT tickets (default 50).
 *   - A batch stops once its own spend reaches ANALYZE_BATCH_MAX_USD (default $1), so a
 *     model that suddenly emits far more tokens than expected cannot run up a bill.
 *   - The tenant's monthly token cap is checked before every ticket.
 *   - A model with no known price is refused outright: with no price the spend cannot
 *     be measured, and costUsd would otherwise record it as $0.
 *
 * The estimate shown to an admin before a batch uses this tenant's own recent runs when
 * there are any, and a deliberately generous default when there are not.
 */
import { getConfig, priceFor } from '@specfix/core';
import { recentAnalysisTokenAverage } from '@specfix/db';

/** Per-ticket token guess with no history. The gold-set run averaged ~1.3k in / ~0.1k out. */
const DEFAULT_INPUT_TOKENS = 2_000;
const DEFAULT_OUTPUT_TOKENS = 1_000;

export function analyzeBatchLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANALYZE_BATCH_LIMIT);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 50;
}

export function analyzeBatchMaxUsd(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ANALYZE_BATCH_MAX_USD);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The model analysis runs on, and whether its price is known. */
export function analysisModel(): { model: string; priced: boolean } {
  const model = getConfig().modelJudge;
  return { model, priced: priceFor(model) !== undefined };
}

export interface CostEstimate {
  model: string;
  priced: boolean;
  tickets: number;
  perTicketUsd: number;
  totalUsd: number;
  basis: 'history' | 'default';
}

export async function estimateAnalysisCost(
  tenantId: string,
  tickets: number
): Promise<CostEstimate> {
  const { model, priced } = analysisModel();
  const price = priceFor(model);
  const history = await recentAnalysisTokenAverage(tenantId);
  const input = history?.input ?? DEFAULT_INPUT_TOKENS;
  const output = history?.output ?? DEFAULT_OUTPUT_TOKENS;
  const perTicketUsd = price
    ? (input / 1e6) * price.inputPerMillion + (output / 1e6) * price.outputPerMillion
    : 0;
  return {
    model,
    priced,
    tickets,
    perTicketUsd,
    totalUsd: perTicketUsd * tickets,
    basis: history ? 'history' : 'default',
  };
}
