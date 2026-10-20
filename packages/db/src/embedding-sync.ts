/**
 * Lifecycle embedding sync: keep a requirement's vector current when a ticket is
 * ingested, and a scenario's vector current when a reviewer approves or edits it.
 *
 * The callers are the ops `seed` command and the Specs review action. Both need the
 * same decisions — is a vector needed, is the stored one still valid, what to do when
 * the API or the database fails — so they live here once, with the embedding function
 * injected. That keeps this package free of the API client (the same rule the
 * repositories follow, enforced by lint): `embedTextsTolerant` from @specfix/core
 * satisfies `EmbedFn` structurally.
 *
 * Order of work, per item:
 *
 *   1. read the source text and the stored vector; skip with no API call when the
 *      item is not eligible, or its stored vector already matches text and model
 *   2. embed (the injected function retries transient failures itself)
 *   3. log every API call to llm_calls, failed ones included, before any vector write
 *   4. write the vector
 *
 * What is and is not guaranteed. The API call and the database writes cannot share a
 * transaction, so there is no atomicity across them, and none is claimed:
 *
 *   - the review decision or ingested version is already committed when this runs; a
 *     failure here never rolls it back, and is reported as a failure rather than
 *     swallowed (callers must not present a failed sync as success)
 *   - if step 3 fails, step 4 is not attempted: no vector is stored whose spend is not
 *     in llm_calls. The unlogged records are returned so the caller can put them in its
 *     own log; there is no other copy. The item stays missing, so a later backfill
 *     embeds it again — a second, small charge
 *   - if step 4 fails, the spend is logged and the item stays missing or out of date,
 *     which the backfill's work lists find (they include content mismatches)
 *   - nothing here retries a failed sync on its own; recovery is the backfill, run by
 *     an operator
 */
import { splitAcClauses } from '@specfix/shared';
import type { TenantId } from './client.ts';
import {
  clauseEmbeddingsAvailable,
  getClauseEmbeddingState,
  getRequirementEmbeddingSources,
  getScenarioEmbeddingSource,
  recordEmbeddingCalls,
  replaceClauseEmbeddings,
  upsertEmbeddingBatch,
  upsertScenarioEmbeddingIfCurrent,
  type ClauseEmbeddingState,
  type ClauseEmbeddingWrite,
  type EmbeddingCallInput,
  type RequirementEmbeddingSource,
  type ScenarioEmbeddingSource,
  type UpsertRequirementEmbeddingInput,
  type UpsertScenarioEmbeddingInput,
} from './repositories/embeddings.ts';

/**
 * Embeds texts, one vector per input in input order. Expected not to throw for API
 * failures: a failed input comes back as `[]` and its failed call is in `calls`, which
 * is `embedTextsTolerant`'s contract. A throw is still handled — any `calls` attached
 * to the error (as `EmbeddingCallError` attaches them) are logged.
 */
export type EmbedFn = (
  texts: readonly string[]
) => Promise<{ vectors: number[][]; calls: readonly EmbeddingCallInput[] }>;

export interface EmbeddingSyncDeps {
  embed: EmbedFn;
  /** Stored beside the vector and compared against it: a model change means re-embed. */
  model: string;
}

/** The repository functions the sync uses, injectable so the logic tests offline. */
export interface EmbeddingSyncRepo {
  getRequirementEmbeddingSources: typeof getRequirementEmbeddingSources;
  getScenarioEmbeddingSource: typeof getScenarioEmbeddingSource;
  recordEmbeddingCalls: typeof recordEmbeddingCalls;
  upsertEmbeddingBatch: (
    tenantId: TenantId,
    input: { requirements: readonly UpsertRequirementEmbeddingInput[] }
  ) => Promise<unknown>;
  upsertScenarioEmbeddingIfCurrent: (
    tenantId: TenantId,
    input: UpsertScenarioEmbeddingInput
  ) => Promise<boolean>;
  clauseEmbeddingsAvailable: () => Promise<boolean>;
  getClauseEmbeddingState: typeof getClauseEmbeddingState;
  replaceClauseEmbeddings: (
    tenantId: TenantId,
    writes: readonly ClauseEmbeddingWrite[]
  ) => Promise<number>;
}

const defaultRepo: EmbeddingSyncRepo = {
  getRequirementEmbeddingSources,
  getScenarioEmbeddingSource,
  recordEmbeddingCalls,
  upsertEmbeddingBatch,
  upsertScenarioEmbeddingIfCurrent,
  clauseEmbeddingsAvailable,
  getClauseEmbeddingState,
  replaceClauseEmbeddings,
};

export type SkipReason =
  /** Migration 0006 is not applied here, so there is nowhere to store clause vectors. */
  | 'schema_missing'
  /** No such row in this tenant. */
  | 'not_found'
  /** Nothing to embed. */
  | 'blank'
  /** A superseded ticket version: no one reviews it, so it is not worth paying for. */
  | 'not_current'
  /** Draft, dismissed or stale: not counted as coverage, so not embedded. */
  | 'not_accepted'
  /** The scenario changed between reading its text and writing its vector. */
  | 'superseded';

export type FailureStage = 'load' | 'embed' | 'record_calls' | 'write_vector';

export type EmbeddingSyncOutcome =
  | { status: 'embedded' }
  /** The stored vector already matches the text and model; no API call was made. */
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'failed'; stage: FailureStage; error: string };

export interface EmbeddingSyncResult {
  outcomes: { id: string; outcome: EmbeddingSyncOutcome }[];
  /** Every API call this sync made, failed ones included. */
  calls: readonly EmbeddingCallInput[];
  /**
   * Null when `calls` are in llm_calls (or there were none). Otherwise why logging
   * failed — and `calls` is then the only copy of those records.
   */
  callLogError: string | null;
}

/**
 * Brings requirement vectors up to date for the given ticket versions — the ones an
 * ingest just created or touched. One embedding request covers every version that
 * needs one; versions already embedded with the same text and model cost nothing.
 */
export async function syncRequirementEmbeddings(
  tenantId: TenantId,
  ticketVersionIds: readonly string[],
  deps: EmbeddingSyncDeps,
  repo: EmbeddingSyncRepo = defaultRepo
): Promise<EmbeddingSyncResult> {
  const ids = [...new Set(ticketVersionIds)];
  const result: EmbeddingSyncResult = { outcomes: [], calls: [], callLogError: null };
  if (ids.length === 0) return result;

  let sources: RequirementEmbeddingSource[];
  try {
    sources = await repo.getRequirementEmbeddingSources(tenantId, ids);
  } catch (error) {
    result.outcomes = ids.map((id) => failed(id, 'load', error));
    return result;
  }

  const byId = new Map(sources.map((source) => [source.ticketVersionId, source]));
  const outcomes = new Map<string, EmbeddingSyncOutcome>();
  const work: RequirementEmbeddingSource[] = [];

  for (const id of ids) {
    const source = byId.get(id);
    const skip = !source
      ? 'not_found'
      : !source.isCurrent
        ? 'not_current'
        : source.content.trim() === ''
          ? 'blank'
          : null;
    if (skip) outcomes.set(id, { status: 'skipped', reason: skip });
    else if (source && isCurrentVector(source, deps.model))
      outcomes.set(id, { status: 'unchanged' });
    else if (source) work.push(source);
  }

  if (work.length > 0) {
    const embedded = await embedAndLog(
      tenantId,
      work.map((source) => source.content),
      deps,
      repo
    );
    result.calls = embedded.calls;
    result.callLogError = embedded.callLogError;

    const writes: UpsertRequirementEmbeddingInput[] = [];
    work.forEach((source, index) => {
      const problem = embedded.problemFor(index);
      if (problem) {
        outcomes.set(source.ticketVersionId, problem);
        return;
      }
      writes.push({
        ticketVersionId: source.ticketVersionId,
        content: source.content,
        embedding: embedded.vectors[index] ?? [],
        model: deps.model,
      });
    });

    if (writes.length > 0) {
      // Requirement text is immutable per version, so unlike scenarios there is no race
      // to guard: the vector for a version's text is always that version's vector.
      try {
        await repo.upsertEmbeddingBatch(tenantId, { requirements: writes });
        for (const write of writes) outcomes.set(write.ticketVersionId, { status: 'embedded' });
      } catch (error) {
        for (const write of writes) {
          outcomes.set(
            write.ticketVersionId,
            failed(write.ticketVersionId, 'write_vector', error).outcome
          );
        }
      }
    }
  }

  result.outcomes = ids.map((id) => ({
    id,
    outcome: outcomes.get(id) ?? { status: 'skipped', reason: 'not_found' },
  }));
  return result;
}

/**
 * Brings one scenario's vector up to date after a review decision. Only approved and
 * edited scenarios are embedded — the same set the coverage queries count — and the
 * text embedded is `gherkin_raw`, so an edit's vector reflects the reviewer's wording.
 */
export async function syncScenarioEmbedding(
  tenantId: TenantId,
  scenarioId: string,
  deps: EmbeddingSyncDeps,
  repo: EmbeddingSyncRepo = defaultRepo
): Promise<EmbeddingSyncResult> {
  const result: EmbeddingSyncResult = { outcomes: [], calls: [], callLogError: null };
  const done = (outcome: EmbeddingSyncOutcome): EmbeddingSyncResult => {
    result.outcomes = [{ id: scenarioId, outcome }];
    return result;
  };

  let source: ScenarioEmbeddingSource | null;
  try {
    source = await repo.getScenarioEmbeddingSource(tenantId, scenarioId);
  } catch (error) {
    return done(failed(scenarioId, 'load', error).outcome);
  }

  if (!source) return done({ status: 'skipped', reason: 'not_found' });
  if (source.status !== 'approved' && source.status !== 'edited') {
    return done({ status: 'skipped', reason: 'not_accepted' });
  }
  if (source.content.trim() === '') return done({ status: 'skipped', reason: 'blank' });
  if (isCurrentVector(source, deps.model)) return done({ status: 'unchanged' });

  const embedded = await embedAndLog(tenantId, [source.content], deps, repo);
  result.calls = embedded.calls;
  result.callLogError = embedded.callLogError;

  const problem = embedded.problemFor(0);
  if (problem) return done(problem);

  try {
    const written = await repo.upsertScenarioEmbeddingIfCurrent(tenantId, {
      scenarioId,
      content: source.content,
      embedding: embedded.vectors[0] ?? [],
      model: deps.model,
    });
    return done(written ? { status: 'embedded' } : { status: 'skipped', reason: 'superseded' });
  } catch (error) {
    return done(failed(scenarioId, 'write_vector', error).outcome);
  }
}

/**
 * Brings per-clause vectors up to date for the given ticket versions, so the coverage
 * view can say which AC clause a scenario covers and which nothing covers.
 *
 * Clauses come from `splitAcClauses` — the generation eval's definition — and a
 * version's clauses are written as a set or not at all: a version whose clauses did not
 * all embed keeps whatever it had before, rather than a partial set that would report
 * the missing clauses as uncovered. A version whose stored clauses already match the
 * split text and model costs nothing. Where migration 0006 has not been applied, every
 * version is skipped with `schema_missing` and no API call is made.
 */
export async function syncClauseEmbeddings(
  tenantId: TenantId,
  ticketVersionIds: readonly string[],
  deps: EmbeddingSyncDeps,
  repo: EmbeddingSyncRepo = defaultRepo
): Promise<EmbeddingSyncResult> {
  const ids = [...new Set(ticketVersionIds)];
  const result: EmbeddingSyncResult = { outcomes: [], calls: [], callLogError: null };
  if (ids.length === 0) return result;

  let states: ClauseEmbeddingState[];
  try {
    if (!(await repo.clauseEmbeddingsAvailable())) {
      result.outcomes = ids.map((id) => ({
        id,
        outcome: { status: 'skipped', reason: 'schema_missing' },
      }));
      return result;
    }
    states = await repo.getClauseEmbeddingState(tenantId, ids);
  } catch (error) {
    result.outcomes = ids.map((id) => failed(id, 'load', error));
    return result;
  }

  const byId = new Map(states.map((state) => [state.ticketVersionId, state]));
  const outcomes = new Map<string, EmbeddingSyncOutcome>();
  const work: { ticketVersionId: string; clauses: string[]; offset: number }[] = [];
  const texts: string[] = [];

  for (const id of ids) {
    const state = byId.get(id);
    if (!state) {
      outcomes.set(id, { status: 'skipped', reason: 'not_found' });
      continue;
    }
    if (!state.isCurrent) {
      outcomes.set(id, { status: 'skipped', reason: 'not_current' });
      continue;
    }
    const clauses = splitAcClauses(state.acceptanceCriteriaText);
    if (clauses.length === 0) {
      outcomes.set(id, { status: 'skipped', reason: 'blank' });
      continue;
    }
    const current =
      state.stored.length === clauses.length &&
      state.stored.every(
        (stored, index) =>
          stored.clauseIndex === index &&
          stored.content === clauses[index] &&
          stored.model === deps.model
      );
    if (current) {
      outcomes.set(id, { status: 'unchanged' });
      continue;
    }
    work.push({ ticketVersionId: id, clauses, offset: texts.length });
    texts.push(...clauses);
  }

  if (work.length > 0) {
    const embedded = await embedAndLog(tenantId, texts, deps, repo);
    result.calls = embedded.calls;
    result.callLogError = embedded.callLogError;

    const writes: ClauseEmbeddingWrite[] = [];
    for (const item of work) {
      const problem = item.clauses
        .map((_, i) => embedded.problemFor(item.offset + i))
        .find((p) => p !== null);
      if (problem) {
        outcomes.set(item.ticketVersionId, problem);
        continue;
      }
      writes.push({
        ticketVersionId: item.ticketVersionId,
        model: deps.model,
        clauses: item.clauses.map((content, i) => ({
          clauseIndex: i,
          content,
          embedding: embedded.vectors[item.offset + i] ?? [],
        })),
      });
    }

    if (writes.length > 0) {
      try {
        await repo.replaceClauseEmbeddings(tenantId, writes);
        for (const write of writes) outcomes.set(write.ticketVersionId, { status: 'embedded' });
      } catch (error) {
        for (const write of writes) {
          outcomes.set(
            write.ticketVersionId,
            failed(write.ticketVersionId, 'write_vector', error).outcome
          );
        }
      }
    }
  }

  result.outcomes = ids.map((id) => ({
    id,
    outcome: outcomes.get(id) ?? { status: 'skipped', reason: 'not_found' },
  }));
  return result;
}

/**
 * A one-line, user-facing account of why a sync did not leave its item with a current
 * vector, or null when it did (or had no reason to). The Specs action shows this after
 * a decision that was itself saved, so it says what happened to the embedding and how
 * it recovers — not that the decision failed.
 */
export function describeEmbeddingProblem(result: EmbeddingSyncResult): string | null {
  const failures = result.outcomes.flatMap(({ outcome }) =>
    outcome.status === 'failed' ? [outcome] : []
  );
  const first = failures[0];
  if (!first) return null;

  switch (first.stage) {
    case 'load':
      return `its embedding was not updated: the database could not be read (${first.error}). The next embedding backfill will pick it up.`;
    case 'embed':
      return `its embedding could not be generated (${first.error}). The next embedding backfill will retry it.`;
    case 'record_calls':
      return `the embedding API call could not be logged to llm_calls (${first.error}), so its vector was not stored. The call details are in the server log; the next embedding backfill will embed it again.`;
    case 'write_vector':
      return `its embedding could not be stored (${first.error}). The API call was logged; the next embedding backfill will retry it.`;
  }
}

/** True when the stored vector was built from exactly this text with this model. */
function isCurrentVector(
  source: { content: string; embeddedContent: string | null; embeddedModel: string | null },
  model: string
): boolean {
  return source.embeddedContent === source.content && source.embeddedModel === model;
}

interface EmbedAndLogResult {
  vectors: number[][];
  calls: readonly EmbeddingCallInput[];
  callLogError: string | null;
  /** The failure outcome for input `index`, or null when it has a vector to store. */
  problemFor(index: number): EmbeddingSyncOutcome | null;
}

/** Steps 2 and 3: embed, then log every call before anything is written. */
async function embedAndLog(
  tenantId: TenantId,
  texts: readonly string[],
  deps: EmbeddingSyncDeps,
  repo: EmbeddingSyncRepo
): Promise<EmbedAndLogResult> {
  let vectors: number[][] = texts.map(() => []);
  let calls: readonly EmbeddingCallInput[] = [];
  let embedError: string | null = null;

  try {
    const outcome = await deps.embed(texts);
    vectors = outcome.vectors;
    calls = outcome.calls;
  } catch (error) {
    // Configuration errors and the like throw before any request; a strict embedder's
    // EmbeddingCallError carries the records of the requests it did make.
    embedError = message(error);
    const attached = (error as { calls?: unknown }).calls;
    if (Array.isArray(attached)) calls = attached as EmbeddingCallInput[];
  }

  let callLogError: string | null = null;
  if (calls.length > 0) {
    try {
      await repo.recordEmbeddingCalls(tenantId, calls);
    } catch (error) {
      callLogError = message(error);
    }
  }

  const apiError =
    embedError ?? calls.find((call) => call.error)?.error ?? 'the embedding API returned no vector';

  return {
    vectors,
    calls,
    callLogError,
    problemFor(index) {
      const vector = vectors[index] ?? [];
      if (vector.length === 0) return { status: 'failed', stage: 'embed', error: apiError };
      if (callLogError !== null) {
        return { status: 'failed', stage: 'record_calls', error: callLogError };
      }
      return null;
    },
  };
}

function failed(
  id: string,
  stage: FailureStage,
  error: unknown
): { id: string; outcome: EmbeddingSyncOutcome } {
  return { id, outcome: { status: 'failed', stage, error: message(error) } };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
