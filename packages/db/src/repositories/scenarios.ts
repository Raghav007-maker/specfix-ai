/**
 * Scenario persistence and review: the write path a reviewer's clicks take.
 *
 * The counterpart of flags.ts for Phase 2 artifacts. Two rules carry over unchanged:
 *
 *  1. Every status change goes through a decision function that writes both the new
 *     status and an append-only `scenario_reviews` row in one transaction. There is no
 *     path that changes a scenario's status without an audit row, because the
 *     acceptance-rate metric is computed from that history.
 *
 *  2. A generated scenario belongs to a ticket_version, and a superseded version's
 *     scenarios are marked stale rather than silently reattached — the same mechanism
 *     flags use, verified by the re-ingest path in tickets.ts.
 *
 * `recordCompilation` also writes the compile run, its scenarios, and its LLM calls in
 * one transaction, for the same reason `recordAnalysis` does: a run row with no
 * scenarios reads as "the model found nothing testable", which is a different claim
 * from "the insert died halfway".
 */
import type { PoolClient, QueryResultRow } from 'pg';
import {
  isApprovedScenario,
  isReviewedScenario,
  type ScenarioOrigin,
  type ScenarioStatus,
} from '@specfix/shared';
import { tx, query, type TenantId } from '../client.ts';

export interface SpecCompileRunRow {
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

export interface ScenarioRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  ticket_version_id: string;
  compile_run_id: string | null;
  title: string;
  gherkin_raw: string;
  status: ScenarioStatus;
  origin: ScenarioOrigin;
  source_flag_ids: string[];
  covers_ac: string;
  rationale: string;
  dedupe_key: string;
}

export interface CompileMetaInput {
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Shaped to accept `CompiledScenario` from @specfix/compiler without translation. */
export interface ScenarioInput {
  title: string;
  gherkin: string;
  covers_ac: string;
  rationale: string;
  dedupeKey: string;
  sourceFlagIds: string[];
  origin?: ScenarioOrigin;
}

/** Shaped to accept `LlmCallRecord` from @specfix/core. */
export interface CompileCallInput {
  purpose: 'compile_gherkin';
  promptVersion: string;
  model: string;
  request: unknown;
  response: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string | null;
}

export interface RecordCompilationInput {
  ticketId: string;
  ticketVersionId: string;
  meta: CompileMetaInput;
  scenarios: readonly ScenarioInput[];
  calls: readonly CompileCallInput[];
}

export interface RecordCompilationResult {
  run: SpecCompileRunRow;
  /** Ids of scenarios actually inserted. Already-existing dedupe keys are skipped. */
  scenarioIds: string[];
  /** Scenarios whose dedupe key already existed for this version, so nothing was inserted. */
  scenariosSkipped: number;
}

export async function recordCompilation(
  tenantId: TenantId,
  input: RecordCompilationInput
): Promise<RecordCompilationResult> {
  return tx(async (client) => {
    const [run] = await rows<SpecCompileRunRow>(
      client,
      `insert into spec_compile_runs (
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
    if (!run) throw new Error('spec_compile_runs insert returned no row');

    const scenarioIds: string[] = [];
    for (const scenario of input.scenarios) {
      // `on conflict do nothing` rather than an update: a scenario already recorded for
      // this version may carry a reviewer's decision, and re-compiling must not
      // overwrite it. Mirrors recordAnalysis.
      const inserted = await rows<{ id: string }>(
        client,
        `insert into scenarios (
           tenant_id, ticket_id, ticket_version_id, compile_run_id, title, gherkin_raw,
           status, origin, source_flag_ids, covers_ac, rationale, dedupe_key
         ) values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11)
         on conflict (tenant_id, ticket_version_id, dedupe_key) do nothing
         returning id`,
        [
          tenantId,
          input.ticketId,
          input.ticketVersionId,
          run.id,
          scenario.title,
          scenario.gherkin,
          scenario.origin ?? 'ai_agent',
          scenario.sourceFlagIds,
          scenario.covers_ac,
          scenario.rationale,
          scenario.dedupeKey,
        ]
      );
      const insertedId = inserted[0]?.id;
      if (insertedId) {
        scenarioIds.push(insertedId);

        // Traceability is written as the scenario lands, so coverage never depends on a
        // later sweep that might not run. One requirement->scenario link per source flag.
        for (const flagId of scenario.sourceFlagIds) {
          await client.query(
            `insert into traceability_links (
               tenant_id, ticket_version_id, flag_id, scenario_id, link_type, created_by
             ) values ($1, $2, $3, $4, 'requirement_to_scenario', 'compiler')`,
            [tenantId, input.ticketVersionId, flagId, insertedId]
          );
        }
      }
    }

    for (const call of input.calls) {
      await client.query(
        `insert into llm_calls (
           tenant_id, compile_run_id, purpose, prompt_version, model, request,
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

    return {
      run,
      scenarioIds,
      scenariosSkipped: input.scenarios.length - scenarioIds.length,
    };
  });
}

export async function listScenariosForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<ScenarioRow[]> {
  return query<ScenarioRow>(
    `${SCENARIO_SELECT}
     where tenant_id = $1 and ticket_version_id = $2 and status <> 'stale'
     order by created_at`,
    [tenantId, ticketVersionId]
  );
}

/** One scenario, or null when it does not exist in this tenant. */
export async function getScenario(
  tenantId: TenantId,
  scenarioId: string
): Promise<ScenarioRow | null> {
  const [row] = await query<ScenarioRow>(`${SCENARIO_SELECT} where tenant_id = $1 and id = $2`, [
    tenantId,
    scenarioId,
  ]);
  return row ?? null;
}

/**
 * How many scenarios on this ticket were staled by a later version. A non-zero count is
 * the drift signal: the ticket text changed after specs were approved, so the current
 * version's specs may not reflect what was reviewed earlier.
 */
export async function countStaleScenariosForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<number> {
  const [row] = await query<{ n: string }>(
    `select count(*)::text as n from scenarios
     where tenant_id = $1 and ticket_id = $2 and status = 'stale'`,
    [tenantId, ticketId]
  );
  return Number(row?.n ?? 0);
}

export async function listScenariosForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<ScenarioRow[]> {
  return query<ScenarioRow>(
    `${SCENARIO_SELECT}
     where tenant_id = $1 and ticket_id = $2
     order by ticket_version_id, created_at`,
    [tenantId, ticketId]
  );
}

/**
 * Approved scenarios only — the set a scaffold emitter may read.
 *
 * This is the gate in code: `emitScaffoldForScenario` below calls it, so there is no
 * path from a `draft` scenario to an emitted scaffold even if a caller asks for one.
 */
export async function listApprovedScenarios(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<ScenarioRow[]> {
  return query<ScenarioRow>(
    `${SCENARIO_SELECT}
     where tenant_id = $1 and ticket_version_id = $2 and status in ('approved', 'edited')
     order by created_at`,
    [tenantId, ticketVersionId]
  );
}

export type ScenarioDecision = 'approved' | 'edited' | 'dismissed' | 'reopened';

export class ScenarioDecisionError extends Error {}

export interface DecideScenarioInput {
  scenarioId: string;
  userId: string;
  decision: ScenarioDecision;
  /** Required for `edited`: the reviewer's replacement Gherkin text. */
  editedText?: string | undefined;
  resolutionNote?: string | undefined;
}

export async function decideScenario(
  tenantId: TenantId,
  input: DecideScenarioInput
): Promise<ScenarioRow> {
  if (input.decision === 'edited' && !input.editedText?.trim()) {
    throw new ScenarioDecisionError("an edited scenario needs the reviewer's replacement text");
  }

  return tx(async (client) => {
    const [existing] = await rows<ScenarioRow>(
      client,
      `${SCENARIO_SELECT} where tenant_id = $1 and id = $2 for update`,
      [tenantId, input.scenarioId]
    );
    if (!existing) {
      throw new ScenarioDecisionError(`no such scenario: ${input.scenarioId}`);
    }
    if (existing.status === 'stale') {
      throw new ScenarioDecisionError(
        'this scenario belongs to a superseded version of the ticket and cannot be decided'
      );
    }
    if (input.decision === 'reopened' && !isReviewedScenario(existing.status)) {
      throw new ScenarioDecisionError(`cannot reopen a scenario that is ${existing.status}`);
    }

    const nextStatus: ScenarioStatus = input.decision === 'reopened' ? 'draft' : input.decision;

    const [updated] = await rows<ScenarioRow>(
      client,
      `update scenarios set status = $3, gherkin_raw = $4
       where tenant_id = $1 and id = $2
       returning ${SCENARIO_COLUMNS}`,
      [
        tenantId,
        input.scenarioId,
        nextStatus,
        // An edit replaces the rendered Gherkin — that is the reviewed artifact. Reopen
        // clears it back to the compiler's original so the UI does not show edited text
        // on an undecided scenario.
        input.decision === 'edited' ? (input.editedText as string) : existing.gherkin_raw,
      ]
    );
    if (!updated) throw new ScenarioDecisionError(`no such scenario: ${input.scenarioId}`);

    await client.query(
      `insert into scenario_reviews (tenant_id, scenario_id, user_id, decision, edited_text, resolution_note)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        input.scenarioId,
        input.userId,
        input.decision,
        input.editedText ?? null,
        input.resolutionNote ?? null,
      ]
    );

    return updated;
  });
}

export interface ScenarioReviewRow {
  id: string;
  scenario_id: string;
  user_id: string;
  decision: ScenarioDecision;
  edited_text: string | null;
  resolution_note: string | null;
  created_at: Date;
}

export async function listScenarioReviews(
  tenantId: TenantId,
  scenarioId: string
): Promise<ScenarioReviewRow[]> {
  return query<ScenarioReviewRow>(
    `select id, scenario_id, user_id, decision, edited_text, resolution_note, created_at
     from scenario_reviews
     where tenant_id = $1 and scenario_id = $2
     order by created_at`,
    [tenantId, scenarioId]
  );
}

export interface ScenarioReviewDetailRow extends ScenarioReviewRow {
  /** Null for rows whose actor has no email (should not happen; user_id is NOT NULL). */
  user_email: string | null;
  scenario_title: string;
}

/**
 * Every scenario decision ever recorded for one version, oldest first — the audit
 * trail the Specs tab shows, the counterpart of `listDecisionsForTicket`. Joined to the
 * scenario and the actor so it reads as "who decided what about which scenario".
 */
export async function listScenarioReviewsForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<ScenarioReviewDetailRow[]> {
  return query<ScenarioReviewDetailRow>(
    `select r.id, r.scenario_id, r.user_id, r.decision, r.edited_text, r.resolution_note,
            r.created_at, u.email as user_email, s.title as scenario_title
     from scenario_reviews r
     join scenarios s on s.id = r.scenario_id and s.tenant_id = r.tenant_id
     left join auth.users u on u.id = r.user_id
     where r.tenant_id = $1 and s.ticket_version_id = $2
     order by r.created_at`,
    [tenantId, ticketVersionId]
  );
}

/** Acceptance inputs straight from the review history, shaped for `scenarioAcceptance`. */
export interface ScenarioAcceptanceCounts {
  acceptedAsIs: number;
  acceptedAfterEdit: number;
  dismissed: number;
  /** Model scenarios with no standing decision (never reviewed, or reopened since). */
  undecided: number;
  /** Human-authored scenarios in the same scope, excluded from the counts above. */
  humanExcluded: number;
}

/**
 * Scenario acceptance over model-generated scenarios, from `scenario_reviews`.
 *
 * Each scenario counts once, by its latest decision; a latest `reopened` means no
 * standing verdict, so it is undecided rather than evidence either way. A scenario
 * that was ever edited and is now accepted counts as accepted-after-edit even if its
 * last click was "approve": the wording a reviewer rewrote is not the model's, which
 * is the split `scenarioAcceptance` exists to keep honest.
 *
 * Stale scenarios keep their verdict: a decision made before the ticket changed is
 * still a judgment of what the model produced. Only `origin = 'ai_agent'` rows enter
 * the counts, for the same reason precisionCounts filters flags — a scenario a person
 * wrote is accepted by construction.
 *
 * `promptVersion` matches the stored version exactly or by name, so both
 * `compile-gherkin-v1` and `compile-gherkin-v1@<hash>` work; with it, hand-authored
 * scenarios (no compile run) drop out of scope.
 */
export async function scenarioAcceptanceCounts(
  tenantId: TenantId,
  promptVersion?: string
): Promise<ScenarioAcceptanceCounts> {
  const [row] = await query<{
    as_is: string;
    after_edit: string;
    dismissed: string;
    undecided: string;
    human: string;
  }>(
    `with scoped as (
       select s.id, s.origin
       from scenarios s
       left join spec_compile_runs r on r.id = s.compile_run_id and r.tenant_id = s.tenant_id
       where s.tenant_id = $1
         and ($2::text is null or r.prompt_version = $2
                              or left(r.prompt_version, length($2) + 1) = $2 || '@')
     ),
     latest as (
       select distinct on (v.scenario_id) v.scenario_id, v.decision
       from scenario_reviews v
       join scoped on scoped.id = v.scenario_id
       where v.tenant_id = $1
       order by v.scenario_id, v.created_at desc, v.id desc
     ),
     ever_edited as (
       select distinct v.scenario_id
       from scenario_reviews v
       join scoped on scoped.id = v.scenario_id
       where v.tenant_id = $1 and v.decision = 'edited'
     )
     select
       count(*) filter (
         where s.origin = 'ai_agent' and l.decision = 'approved' and e.scenario_id is null
       )::text as as_is,
       count(*) filter (
         where s.origin = 'ai_agent' and l.decision in ('approved', 'edited')
           and e.scenario_id is not null
       )::text as after_edit,
       count(*) filter (where s.origin = 'ai_agent' and l.decision = 'dismissed')::text
         as dismissed,
       count(*) filter (
         where s.origin = 'ai_agent' and (l.decision is null or l.decision = 'reopened')
       )::text as undecided,
       count(*) filter (where s.origin <> 'ai_agent')::text as human
     from scoped s
     left join latest l on l.scenario_id = s.id
     left join ever_edited e on e.scenario_id = s.id`,
    [tenantId, promptVersion ?? null]
  );
  return {
    acceptedAsIs: Number(row?.as_is ?? 0),
    acceptedAfterEdit: Number(row?.after_edit ?? 0),
    dismissed: Number(row?.dismissed ?? 0),
    undecided: Number(row?.undecided ?? 0),
    humanExcluded: Number(row?.human ?? 0),
  };
}

/** True when a scenario is in a state that counts as accepted. Re-exported for callers. */
export { isApprovedScenario };

const SCENARIO_COLUMNS = `id, tenant_id, ticket_id, ticket_version_id, compile_run_id, title,
       gherkin_raw, status, origin, source_flag_ids, covers_ac, rationale, dedupe_key`;

const SCENARIO_SELECT = `select ${SCENARIO_COLUMNS} from scenarios`;

async function rows<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  const result = await client.query<T>(sql, params as unknown[]);
  return result.rows;
}
