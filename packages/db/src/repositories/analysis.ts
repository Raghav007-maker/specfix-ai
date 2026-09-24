/**
 * Analysis run persistence: the bridge between core (which returns data) and the
 * database (which is the eval substrate).
 *
 * `recordAnalysis` writes the run, its flags, and its LLM calls in one transaction.
 * A partial write here is worse than a failed one — a run row with no flags reads as
 * "the model found nothing", which is a different claim from "the insert died
 * halfway".
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { tx, query, type TenantId } from '../client.ts';

export interface AnalysisRunRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  ticket_version_id: string;
  prompt_version: string;
  model: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  truncated: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  error: string | null;
}

/** Shaped to accept `AnalyzeOutcome.meta` from @specfix/core without translation. */
export interface AnalysisMetaInput {
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Shaped to accept `AnalyzedFlag`, `ApprovedFlag` and `PrunedFlag` from
 * @specfix/core without translation — hence the optional critic fields, which are
 * absent on a single-shot run and present on a deliberated one.
 */
export interface FlagInput {
  category: string;
  quoted_span: string;
  what_unclear: string;
  why_it_matters: string;
  question_for_pm: string;
  severity: string;
  dedupeKey: string;
  /** Defaults to 'ai_agent'. Only 'ai_agent' rows enter a precision denominator. */
  origin?: 'ai_agent' | 'developer';
  /** Absent when no Critic pass ran. Stored as null, which is not the same as 'keep'. */
  criticVerdict?: 'keep' | 'prune';
  criticReason?: string;
  /** The Extractor's wording, stored only when the Critic actually changed it. */
  originalQuestion?: string;
  originalSeverity?: string;
}

/** Shaped to accept `LlmCallRecord` from @specfix/core. */
export interface LlmCallInput {
  purpose: 'extract' | 'critic' | 'judge' | 'single_shot';
  promptVersion: string;
  model: string;
  request: unknown;
  response: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** null and undefined both mean "no error"; the insert normalizes to null. */
  error?: string | null;
}

export interface RecordAnalysisInput {
  ticketId: string;
  ticketVersionId: string;
  meta: AnalysisMetaInput;
  flags: readonly FlagInput[];
  calls: readonly LlmCallInput[];
}

export interface RecordAnalysisResult {
  run: AnalysisRunRow;
  /** Flags a reviewer will see. Excludes anything the Critic pruned. */
  flagIds: string[];
  /**
   * Flags the Critic rejected, stored but hidden. Kept separate so a caller cannot
   * accidentally report a pruned flag as work produced — and so the control arm has
   * somewhere to read them from.
   */
  prunedFlagIds: string[];
  /** Flags whose dedupe_key already existed for this version, so nothing was inserted. */
  flagsSkipped: number;
}

export async function recordAnalysis(
  tenantId: TenantId,
  input: RecordAnalysisInput
): Promise<RecordAnalysisResult> {
  return tx(async (client) => {
    const [run] = await rows<AnalysisRunRow>(
      client,
      `insert into analysis_runs (
         tenant_id, ticket_id, ticket_version_id, prompt_version, model,
         temperature, seed, status, truncated, input_tokens, output_tokens,
         cost_usd, started_at, finished_at
       ) values ($1, $2, $3, $4, $5, $6, $7, 'succeeded', $8, $9, $10, $11, now(), now())
       returning id, tenant_id, ticket_id, ticket_version_id, prompt_version, model,
                 status, truncated, input_tokens, output_tokens, cost_usd, error`,
      [
        tenantId,
        input.ticketId,
        input.ticketVersionId,
        input.meta.promptVersion,
        input.meta.model,
        input.meta.temperature,
        input.meta.seed,
        input.meta.truncated,
        input.meta.inputTokens,
        input.meta.outputTokens,
        input.meta.costUsd,
      ]
    );

    if (!run) throw new Error('analysis_runs insert returned no row');

    const flagIds: string[] = [];
    const prunedFlagIds: string[] = [];
    for (const flag of input.flags) {
      const pruned = flag.criticVerdict === 'prune';
      // A refinement is only recorded when it actually changed something, so a
      // non-null pre_critic_question always means "the Critic rewrote this".
      const questionChanged =
        flag.originalQuestion !== undefined && flag.originalQuestion !== flag.question_for_pm;
      const severityChanged =
        flag.originalSeverity !== undefined && flag.originalSeverity !== flag.severity;

      // `on conflict do nothing` rather than an update: a flag already recorded for
      // this version may carry a reviewer's verdict, and re-running analysis must
      // not overwrite it.
      const inserted = await rows<{ id: string }>(
        client,
        `insert into flags (
           tenant_id, ticket_id, ticket_version_id, analysis_run_id, category,
           quoted_span, what_unclear, why_it_matters, question_for_pm, severity,
           dedupe_key, origin, status, critic_verdict, critic_reason,
           pre_critic_question, pre_critic_severity
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         on conflict (tenant_id, ticket_version_id, dedupe_key) do nothing
         returning id`,
        [
          tenantId,
          input.ticketId,
          input.ticketVersionId,
          run.id,
          flag.category,
          flag.quoted_span,
          flag.what_unclear,
          flag.why_it_matters,
          flag.question_for_pm,
          flag.severity,
          flag.dedupeKey,
          flag.origin ?? 'ai_agent',
          pruned ? 'pruned' : 'open',
          flag.criticVerdict ?? null,
          flag.criticReason ?? null,
          questionChanged ? flag.originalQuestion : null,
          severityChanged ? flag.originalSeverity : null,
        ]
      );
      if (inserted[0]) (pruned ? prunedFlagIds : flagIds).push(inserted[0].id);
    }

    for (const call of input.calls) {
      await client.query(
        `insert into llm_calls (
           tenant_id, analysis_run_id, purpose, prompt_version, model, request,
           response, latency_ms, input_tokens, output_tokens, cost_usd, error
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          tenantId,
          run.id,
          call.purpose,
          call.promptVersion,
          call.model,
          JSON.stringify(call.request),
          call.response === undefined ? null : JSON.stringify(call.response),
          call.latencyMs,
          call.inputTokens,
          call.outputTokens,
          call.costUsd,
          call.error ?? null,
        ]
      );
    }

    await client.query(
      `insert into readiness_events (tenant_id, ticket_id, ticket_version_id, event)
       values ($1, $2, $3, 'analysis_complete')`,
      [tenantId, input.ticketId, input.ticketVersionId]
    );

    return {
      run,
      flagIds,
      prunedFlagIds,
      flagsSkipped: input.flags.length - flagIds.length - prunedFlagIds.length,
    };
  });
}

/** Records a run that never produced usable output, so the failure is visible in the UI. */
export async function recordFailedAnalysis(
  tenantId: TenantId,
  input: {
    ticketId: string;
    ticketVersionId: string;
    promptVersion: string;
    model: string;
    temperature: number;
    seed: number | null;
    error: string;
    calls?: readonly LlmCallInput[];
  }
): Promise<AnalysisRunRow> {
  return tx(async (client) => {
    const [run] = await rows<AnalysisRunRow>(
      client,
      `insert into analysis_runs (
         tenant_id, ticket_id, ticket_version_id, prompt_version, model,
         temperature, seed, status, error, started_at, finished_at
       ) values ($1, $2, $3, $4, $5, $6, $7, 'failed', $8, now(), now())
       returning id, tenant_id, ticket_id, ticket_version_id, prompt_version, model,
                 status, truncated, input_tokens, output_tokens, cost_usd, error`,
      [
        tenantId,
        input.ticketId,
        input.ticketVersionId,
        input.promptVersion,
        input.model,
        input.temperature,
        input.seed,
        input.error,
      ]
    );

    if (!run) throw new Error('analysis_runs insert returned no row');

    // Failed attempts are still billable and still evidence. Log them.
    for (const call of input.calls ?? []) {
      await client.query(
        `insert into llm_calls (
           tenant_id, analysis_run_id, purpose, prompt_version, model, request,
           response, latency_ms, input_tokens, output_tokens, cost_usd, error
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          tenantId,
          run.id,
          call.purpose,
          call.promptVersion,
          call.model,
          JSON.stringify(call.request),
          call.response === undefined ? null : JSON.stringify(call.response),
          call.latencyMs,
          call.inputTokens,
          call.outputTokens,
          call.costUsd,
          call.error ?? null,
        ]
      );
    }

    return run;
  });
}

export async function listRunsForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<AnalysisRunRow[]> {
  return query<AnalysisRunRow>(
    `select id, tenant_id, ticket_id, ticket_version_id, prompt_version, model,
            status, truncated, input_tokens, output_tokens, cost_usd, error
     from analysis_runs
     where tenant_id = $1 and ticket_id = $2
     order by created_at desc`,
    [tenantId, ticketId]
  );
}

/**
 * Tokens consumed this calendar month, for the per-tenant cap. Read before a call
 * is made — the point is to refuse work, not to explain the bill afterwards.
 */
export async function monthlyTokenUsage(tenantId: TenantId): Promise<number> {
  const [row] = await query<{ total: string }>(
    `select coalesce(sum(input_tokens + output_tokens), 0)::text as total
     from llm_calls
     where tenant_id = $1 and created_at >= date_trunc('month', now())`,
    [tenantId]
  );
  return Number(row?.total ?? 0);
}

export async function isOverTokenCap(tenantId: TenantId): Promise<boolean> {
  const [row] = await query<{ over: boolean }>(
    `select coalesce(
              (select sum(c.input_tokens + c.output_tokens)
                 from llm_calls c
                where c.tenant_id = t.id
                  and c.created_at >= date_trunc('month', now())), 0
            ) >= t.monthly_token_cap as over
     from tenants t
     where t.id = $1`,
    [tenantId]
  );
  if (!row) throw new Error(`no such tenant: ${tenantId}`);
  return row.over;
}

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
