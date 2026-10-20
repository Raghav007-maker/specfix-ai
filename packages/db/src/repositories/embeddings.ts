/**
 * Embedding persistence: the pgvector write and read paths.
 *
 * Scope, per the plan's Milestone D: this module stores vectors and answers
 * "what is near this" queries. It does not decide what counts as covering — the
 * coverage view calls these and applies its own threshold, because a threshold is
 * a product decision and has no business being baked into a repository.
 *
 * Two invariants carried over from every other repository here:
 *
 *  1. Step 1 — every query takes an explicit tenant_id. The worker connects with the
 *     service-role key, so RLS is not the isolation mechanism; this layer is.
 *
 *  2. Step 2 — an embedding is keyed by its source record. Both tables use the source
 *     id as primary key, so re-embedding is an upsert. A backfill that dies halfway
 *     and is re-run converges rather than duplicating.
 *
 * The `content` column is written alongside the vector, always. A vector without the
 * text it came from cannot be checked for staleness, and a stale vector is worse than
 * a missing one: it silently scores against text nobody wrote.
 */
import type { QueryResultRow } from 'pg';
import { tx, query, type TenantId } from '../client.ts';

export interface RequirementEmbeddingRow {
  ticket_version_id: string;
  tenant_id: string;
  content: string;
  model: string;
  created_at: Date;
}

export interface ScenarioEmbeddingRow {
  scenario_id: string;
  tenant_id: string;
  content: string;
  model: string;
  created_at: Date;
}

export interface UpsertRequirementEmbeddingInput {
  ticketVersionId: string;
  /** The exact text the vector represents — AC and requirement text, not the whole ticket. */
  content: string;
  embedding: readonly number[];
  model: string;
}

export interface UpsertScenarioEmbeddingInput {
  scenarioId: string;
  content: string;
  embedding: readonly number[];
  model: string;
}

/**
 * pgvector accepts its text format on insert. Passing it explicitly rather than
 * letting the driver guess keeps the value a string all the way down — node-postgres
 * has no vector type, and a bare JS array would arrive as an unsupported parameter.
 */
function vectorLiteral(embedding: readonly number[]): string {
  if (embedding.length === 0) {
    throw new Error('refusing to store an empty embedding');
  }
  return `[${embedding.join(',')}]`;
}

/**
 * The text a requirement vector represents, as SQL over a ticket_versions alias.
 *
 * AC first: it is what most flags attach to and what a requirement vector should
 * represent. The description is appended for the cases where the AC alone is a stub.
 * Defined once and computed in SQL, never re-derived in TypeScript: the staleness check
 * compares stored `content` against this expression, so every writer — backfill and
 * ingest-time sync alike — must produce byte-identical text. (Postgres `trim` strips
 * spaces only, where JavaScript's strips all whitespace; a second implementation would
 * disagree on exactly the inputs nobody tests.)
 */
function requirementContentSql(v: string): string {
  return `trim(both from concat_ws(E'\\n',
            nullif(${v}.acceptance_criteria_text, ''),
            nullif(${v}.description_text, '')
          ))`;
}

/**
 * Whether a ticket_versions alias is its ticket's current version: the most recently
 * captured one, which is the definition `latestVersion` and the review UI use.
 *
 * `tickets` has no current-version column — the schema never had one — so this is
 * computed. Served by ticket_versions_ticket_idx (tenant_id, ticket_id, captured_at desc).
 */
function isCurrentVersionSql(v: string): string {
  return `${v}.id = (select latest.id from ticket_versions latest
                      where latest.tenant_id = ${v}.tenant_id
                        and latest.ticket_id = ${v}.ticket_id
                      order by latest.captured_at desc
                      limit 1)`;
}

/**
 * The requirement and scenario upserts, shared by the single-row and batch writers.
 * Parameters: $1 source id, $2 tenant, $3 content, $4 vector literal, $5 model.
 *
 * `on conflict ... do update` rather than `do nothing`: unlike a scenario, whose
 * reviewer decisions must survive a re-compile, an embedding carries no human input.
 * The latest vector for the current text is always the correct row.
 *
 * `insert ... select` from the source table, not `values`: the foreign key only proves
 * the id exists *somewhere*, so a `values` insert given another tenant's id would
 * succeed and file a vector of that tenant's row under this one. Selecting the source
 * row by (id, tenant) makes a cross-tenant write insert nothing, the same guarantee the
 * tenant-isolation suite demands of every other write. The conflict update is guarded
 * the same way.
 */
const UPSERT_REQUIREMENT_SQL = `insert into requirement_embeddings (
       ticket_version_id, tenant_id, content, embedding, model
     )
     select v.id, v.tenant_id, $3, $4::vector, $5
     from ticket_versions v
     where v.id = $1 and v.tenant_id = $2
     on conflict (ticket_version_id) do update
       set content = excluded.content,
           embedding = excluded.embedding,
           model = excluded.model,
           created_at = now()
       where requirement_embeddings.tenant_id = excluded.tenant_id`;

const UPSERT_SCENARIO_SQL = `insert into scenario_embeddings (scenario_id, tenant_id, content, embedding, model)
     select s.id, s.tenant_id, $3, $4::vector, $5
     from scenarios s
     where s.id = $1 and s.tenant_id = $2
     on conflict (scenario_id) do update
       set content = excluded.content,
           embedding = excluded.embedding,
           model = excluded.model,
           created_at = now()
       where scenario_embeddings.tenant_id = excluded.tenant_id`;

/** Writes one requirement vector. Throws when the version is not this tenant's. */
export async function upsertRequirementEmbedding(
  tenantId: TenantId,
  input: UpsertRequirementEmbeddingInput
): Promise<RequirementEmbeddingRow> {
  const [row] = await query<RequirementEmbeddingRow>(
    `${UPSERT_REQUIREMENT_SQL}
     returning ticket_version_id, tenant_id, content, model, created_at`,
    [input.ticketVersionId, tenantId, input.content, vectorLiteral(input.embedding), input.model]
  );
  if (!row) throw new Error(`no ticket version ${input.ticketVersionId} in this tenant`);
  return row;
}

/** Writes one scenario vector. Throws when the scenario is not this tenant's. */
export async function upsertScenarioEmbedding(
  tenantId: TenantId,
  input: UpsertScenarioEmbeddingInput
): Promise<ScenarioEmbeddingRow> {
  const [row] = await query<ScenarioEmbeddingRow>(
    `${UPSERT_SCENARIO_SQL}
     returning scenario_id, tenant_id, content, model, created_at`,
    [input.scenarioId, tenantId, input.content, vectorLiteral(input.embedding), input.model]
  );
  if (!row) throw new Error(`no scenario ${input.scenarioId} in this tenant`);
  return row;
}

/**
 * Writes a whole backfill batch in one transaction.
 *
 * One transaction, not one per row: a backfill that is interrupted should leave the
 * table at a batch boundary rather than in the middle of one, so a re-run's work is
 * predictable. Rows whose vector is empty are skipped rather than throwing — under
 * `embedTexts`, an empty vector means the input was blank, which is a fact about the
 * data and not a failure. A row whose id is not this tenant's writes nothing and is
 * counted as skipped (see UPSERT_REQUIREMENT_SQL).
 */
export async function upsertEmbeddingBatch(
  tenantId: TenantId,
  input: {
    requirements?: readonly UpsertRequirementEmbeddingInput[];
    scenarios?: readonly UpsertScenarioEmbeddingInput[];
  }
): Promise<{ requirementsWritten: number; scenariosWritten: number; skipped: number }> {
  let requirementsWritten = 0;
  let scenariosWritten = 0;
  let skipped = 0;

  await tx(async (client) => {
    for (const requirement of input.requirements ?? []) {
      if (requirement.embedding.length === 0) {
        skipped += 1;
        continue;
      }
      const result = await client.query(UPSERT_REQUIREMENT_SQL, [
        requirement.ticketVersionId,
        tenantId,
        requirement.content,
        vectorLiteral(requirement.embedding),
        requirement.model,
      ]);
      if (result.rowCount) requirementsWritten += 1;
      else skipped += 1;
    }

    for (const scenario of input.scenarios ?? []) {
      if (scenario.embedding.length === 0) {
        skipped += 1;
        continue;
      }
      const result = await client.query(UPSERT_SCENARIO_SQL, [
        scenario.scenarioId,
        tenantId,
        scenario.content,
        vectorLiteral(scenario.embedding),
        scenario.model,
      ]);
      if (result.rowCount) scenariosWritten += 1;
      else skipped += 1;
    }
  });

  return { requirementsWritten, scenariosWritten, skipped };
}

/**
 * One embedding call as llm_calls stores it. Structurally the `EmbeddingCallRecord`
 * that @specfix/core produces, declared here rather than imported because this package
 * must not depend on the API client.
 */
export interface EmbeddingCallInput {
  promptVersion: string;
  model: string;
  request: unknown;
  response?: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string | null;
}

/**
 * Logs embedding calls to llm_calls, failed ones included.
 *
 * Separate from the vector writes on purpose, and meant to be called before them: the
 * spend happened when the API answered, whether or not the vectors are then stored, so
 * a failed upsert must not take the cost record down with it.
 *
 * An embedding call belongs to neither an analysis run nor a compile run, so both FKs
 * are null. `purpose` is fixed to 'embed' in the statement rather than taken from the
 * input, so this function cannot be used to log a chat pass under the wrong label.
 * One transaction, so a batch of records lands whole or not at all.
 */
export async function recordEmbeddingCalls(
  tenantId: TenantId,
  calls: readonly EmbeddingCallInput[]
): Promise<number> {
  if (calls.length === 0) return 0;

  await tx(async (client) => {
    for (const call of calls) {
      await client.query(
        `insert into llm_calls (
           tenant_id, analysis_run_id, compile_run_id, purpose, prompt_version, model,
           request, response, latency_ms, input_tokens, output_tokens, cost_usd, error
         ) values ($1, null, null, 'embed', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tenantId,
          call.promptVersion,
          call.model,
          JSON.stringify(call.request),
          // A failed call has `response: null`; store SQL NULL, not the JSON value null.
          call.response === undefined || call.response === null
            ? null
            : JSON.stringify(call.response),
          call.latencyMs,
          call.inputTokens,
          call.outputTokens,
          call.costUsd,
          call.error ?? null,
        ]
      );
    }
  });

  return calls.length;
}

export interface RequirementEmbeddingStateRow {
  ticket_version_id: string;
  content: string;
  model: string;
  created_at: Date;
}

/** The stored requirement vector for a version, or null when it has never been embedded. */
export async function getRequirementEmbedding(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<RequirementEmbeddingStateRow | null> {
  const [row] = await query<RequirementEmbeddingStateRow>(
    `select ticket_version_id, content, model, created_at
     from requirement_embeddings
     where tenant_id = $1 and ticket_version_id = $2`,
    [tenantId, ticketVersionId]
  );
  return row ?? null;
}

/**
 * What the ingest-time sync needs to decide whether a version needs a (new) vector:
 * the text to embed, whether the version is current, and what is stored now.
 */
export interface RequirementEmbeddingSource {
  ticketVersionId: string;
  /** The text to embed, from `requirementContentSql` — identical to what the backfill sends. */
  content: string;
  isCurrent: boolean;
  /** Null when the version has never been embedded. */
  embeddedContent: string | null;
  embeddedModel: string | null;
}

/** One row per id that exists in this tenant; ids from another tenant simply do not appear. */
export async function getRequirementEmbeddingSources(
  tenantId: TenantId,
  ticketVersionIds: readonly string[]
): Promise<RequirementEmbeddingSource[]> {
  if (ticketVersionIds.length === 0) return [];
  return query<RequirementEmbeddingSource>(
    `select v.id as "ticketVersionId",
            ${requirementContentSql('v')} as "content",
            ${isCurrentVersionSql('v')} as "isCurrent",
            r.content as "embeddedContent",
            r.model as "embeddedModel"
     from ticket_versions v
     left join requirement_embeddings r
       on r.ticket_version_id = v.id and r.tenant_id = v.tenant_id
     where v.tenant_id = $1 and v.id = any($2::uuid[])`,
    [tenantId, [...ticketVersionIds]]
  );
}

/** The scenario-side counterpart: the reviewed text and what vector is stored now. */
export interface ScenarioEmbeddingSource {
  scenarioId: string;
  ticketVersionId: string;
  status: string;
  /** `gherkin_raw` — the reviewed artifact, hand-edits included. */
  content: string;
  embeddedContent: string | null;
  embeddedModel: string | null;
}

export async function getScenarioEmbeddingSource(
  tenantId: TenantId,
  scenarioId: string
): Promise<ScenarioEmbeddingSource | null> {
  const [row] = await query<ScenarioEmbeddingSource>(
    `select s.id as "scenarioId",
            s.ticket_version_id as "ticketVersionId",
            s.status as "status",
            s.gherkin_raw as "content",
            e.content as "embeddedContent",
            e.model as "embeddedModel"
     from scenarios s
     left join scenario_embeddings e
       on e.scenario_id = s.id and e.tenant_id = s.tenant_id
     where s.tenant_id = $1 and s.id = $2`,
    [tenantId, scenarioId]
  );
  return row ?? null;
}

/**
 * Writes a scenario vector only if the scenario is still accepted and its text is still
 * exactly `content`. Returns whether a row was written.
 *
 * The API call happens outside any transaction (holding the review's row lock across a
 * network round trip would serialize reviewers behind the model), so between reading
 * the text and writing its vector a second reviewer can edit, dismiss or reopen the
 * scenario. An unconditional upsert would then store a vector for text that no longer
 * exists. Here the check and the write are one statement: a lost race writes nothing,
 * and the later decision's own refresh — or the backfill, which also finds content
 * mismatches — handles the current text.
 */
export async function upsertScenarioEmbeddingIfCurrent(
  tenantId: TenantId,
  input: UpsertScenarioEmbeddingInput
): Promise<boolean> {
  const written = await query<{ scenario_id: string }>(
    `insert into scenario_embeddings (scenario_id, tenant_id, content, embedding, model)
     select s.id, s.tenant_id, $3, $4::vector, $5
     from scenarios s
     where s.tenant_id = $1 and s.id = $2
       and s.gherkin_raw = $3
       and s.status in ('approved', 'edited')
     on conflict (scenario_id) do update
       set content = excluded.content,
           embedding = excluded.embedding,
           model = excluded.model,
           created_at = now()
     returning scenario_id`,
    [tenantId, input.scenarioId, input.content, vectorLiteral(input.embedding), input.model]
  );
  return written.length > 0;
}

/**
 * Versions whose stored requirement text no longer matches what is on the version row.
 *
 * This is the staleness check 0003's comment described: because `content` is kept
 * beside the vector, drift is a comparison rather than a guess. A version with no
 * embedding row at all is returned by `listVersionsMissingEmbeddings` instead — the
 * two are different work items and are reported separately so neither hides the other.
 */
export interface StaleRequirementEmbedding {
  ticketVersionId: string;
  embeddedContent: string;
  currentContent: string;
}

export async function listStaleRequirementEmbeddings(
  tenantId: TenantId,
  input: { limit?: number } = {}
): Promise<StaleRequirementEmbedding[]> {
  const rows = await query<{
    ticket_version_id: string;
    embedded_content: string;
    current_content: string;
  }>(
    `select r.ticket_version_id,
            r.content as embedded_content,
            --- The current analyzable text for the version, in the same shape the
            --- backfill embeds, so the comparison is like for like.
            ${requirementContentSql('v')} as current_content
     from requirement_embeddings r
     join ticket_versions v
       on v.id = r.ticket_version_id and v.tenant_id = r.tenant_id
     where r.tenant_id = $1
       and r.content <> ${requirementContentSql('v')}
     order by r.created_at
     limit $2`,
    [tenantId, input.limit ?? 100]
  );

  return rows.map((row) => ({
    ticketVersionId: row.ticket_version_id,
    embeddedContent: row.embedded_content,
    currentContent: row.current_content,
  }));
}

/** Versions on live tickets that have no requirement vector yet — the backfill's work list. */
export interface VersionMissingEmbedding {
  ticketVersionId: string;
  ticketId: string;
  title: string;
  content: string;
}

export async function listVersionsMissingEmbeddings(
  tenantId: TenantId,
  input: { limit?: number } = {}
): Promise<VersionMissingEmbedding[]> {
  return query<VersionMissingEmbedding>(
    `select v.id as "ticketVersionId",
            v.ticket_id as "ticketId",
            v.title as "title",
            ${requirementContentSql('v')} as "content"
     from ticket_versions v
     left join requirement_embeddings r
       on r.ticket_version_id = v.id and r.tenant_id = v.tenant_id
     where v.tenant_id = $1
       and r.ticket_version_id is null
       --- Only each ticket's current version. Embedding superseded versions would spend
       --- money on text no one is reviewing.
       and ${isCurrentVersionSql('v')}
     order by v.captured_at
     limit $2`,
    [tenantId, input.limit ?? 200]
  );
}

/**
 * Approved and edited scenarios whose vector is missing *or out of date* — the
 * counterpart work list.
 *
 * Out of date means the stored `content` no longer equals `gherkin_raw`. A reviewer's
 * edit replaces gherkin_raw in place, and the review action refreshes the vector right
 * after; if that refresh fails, this is what finds the row again. Without the second
 * condition a failed refresh would leave an existing-but-wrong vector that no work list
 * ever revisits.
 */
export interface ScenarioMissingEmbedding {
  scenarioId: string;
  title: string;
  content: string;
}

/** The accepted-and-needs-a-vector predicate, shared by the work list and the count. */
const SCENARIO_NEEDS_EMBEDDING = `s.status in ('approved', 'edited')
       and (e.scenario_id is null or e.content <> s.gherkin_raw)`;

export async function listScenariosMissingEmbeddings(
  tenantId: TenantId,
  input: { limit?: number } = {}
): Promise<ScenarioMissingEmbedding[]> {
  return query<ScenarioMissingEmbedding>(
    `select s.id as "scenarioId", s.title as "title", s.gherkin_raw as "content"
     from scenarios s
     left join scenario_embeddings e
       on e.scenario_id = s.id and e.tenant_id = s.tenant_id
     where s.tenant_id = $1
       --- Only accepted scenarios. A draft may still be dismissed, and embedding it would
       --- pay for a vector that the coverage denominator does not count anyway.
       and ${SCENARIO_NEEDS_EMBEDDING}
     order by s.created_at
     limit $2`,
    [tenantId, input.limit ?? 200]
  );
}

/**
 * Requirement vectors nearest a scenario vector, within one ticket version.
 *
 * Scoped to a version rather than a tenant: a scenario is written against one version
 * of one ticket, so a "similar requirement" from a different ticket is not a candidate
 * for coverage — it is a coincidence.
 */
export interface NearestRequirement {
  ticketVersionId: string;
  content: string;
  /** Cosine similarity in [-1, 1]; 1 is identical. */
  similarity: number;
}

export async function nearestRequirements(
  tenantId: TenantId,
  input: {
    embedding: readonly number[];
    ticketVersionId: string;
    limit?: number;
  }
): Promise<NearestRequirement[]> {
  if (input.embedding.length === 0) return [];

  return query<NearestRequirement>(
    `select r.ticket_version_id as "ticketVersionId",
            r.content as "content",
            1 - (r.embedding <=> $3::vector) as "similarity"
     from requirement_embeddings r
     where r.tenant_id = $1 and r.ticket_version_id = $2
     order by r.embedding <=> $3::vector
     limit $4`,
    [tenantId, input.ticketVersionId, vectorLiteral(input.embedding), input.limit ?? 5]
  );
}

/**
 * Approved and edited scenarios on a version, ordered by closeness to a requirement
 * vector. The candidate list the fuzzy-coverage view ranks.
 */
export interface NearestScenario {
  scenarioId: string;
  title: string;
  content: string;
  status: string;
  similarity: number;
}

export async function nearestScenarios(
  tenantId: TenantId,
  input: {
    embedding: readonly number[];
    ticketVersionId: string;
    limit?: number;
    /** Cosine floor. Below this a match is noise, so it is not returned at all. */
    minSimilarity?: number;
  }
): Promise<NearestScenario[]> {
  if (input.embedding.length === 0) return [];

  return query<NearestScenario>(
    `select s.id as "scenarioId",
            s.title as "title",
            s.gherkin_raw as "content",
            s.status as "status",
            1 - (e.embedding <=> $3::vector) as "similarity"
     from scenario_embeddings e
     join scenarios s on s.id = e.scenario_id and s.tenant_id = e.tenant_id
     where e.tenant_id = $1
       and s.ticket_version_id = $2
       and s.status in ('approved', 'edited')
       and 1 - (e.embedding <=> $3::vector) >= $5
     order by e.embedding <=> $3::vector
     limit $4`,
    [
      tenantId,
      input.ticketVersionId,
      vectorLiteral(input.embedding),
      input.limit ?? 10,
      input.minSimilarity ?? 0,
    ]
  );
}

/** Counts for a status line, cheap enough to run before and after a backfill. */
export interface EmbeddingCounts {
  requirements: number;
  scenarios: number;
  versionsAwaiting: number;
  scenariosAwaiting: number;
}

export async function embeddingCounts(tenantId: TenantId): Promise<EmbeddingCounts> {
  const [row] = await query<{
    requirements: string;
    scenarios: string;
    versions_awaiting: string;
    scenarios_awaiting: string;
  }>(
    `select
       (select count(*) from requirement_embeddings where tenant_id = $1)::text as requirements,
       (select count(*) from scenario_embeddings where tenant_id = $1)::text as scenarios,
       (select count(*) from ticket_versions v
          left join requirement_embeddings r
            on r.ticket_version_id = v.id and r.tenant_id = v.tenant_id
         where v.tenant_id = $1 and ${isCurrentVersionSql('v')}
           and r.ticket_version_id is null)::text as versions_awaiting,
       (select count(*) from scenarios s
          left join scenario_embeddings e
            on e.scenario_id = s.id and e.tenant_id = s.tenant_id
         where s.tenant_id = $1
           and ${SCENARIO_NEEDS_EMBEDDING})::text as scenarios_awaiting`,
    [tenantId]
  );

  return {
    requirements: Number(row?.requirements ?? 0),
    scenarios: Number(row?.scenarios ?? 0),
    versionsAwaiting: Number(row?.versions_awaiting ?? 0),
    scenariosAwaiting: Number(row?.scenarios_awaiting ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Clause embeddings (migration 0006)
//
// One vector per acceptance-criteria clause, for "which clause has no scenario?" and
// "which approved scenario no longer matches any clause?". Clause text comes from
// `splitAcClauses` (@specfix/shared), computed by the caller, so the eval and the
// coverage view split identically; this layer stores and compares, it does not split.
// ---------------------------------------------------------------------------

let clauseTableSeen = false;

/**
 * Whether migration 0006 has been applied to the database this process talks to.
 *
 * Schema metadata, not tenant data — hence no tenant argument. The coverage view and
 * the sync check it so an environment that has not run 0006 yet degrades to exact
 * coverage instead of failing every page load. Only a positive answer is cached: once
 * the table exists it stays, while a negative answer is re-checked so applying the
 * migration takes effect without a restart.
 */
export async function clauseEmbeddingsAvailable(): Promise<boolean> {
  if (clauseTableSeen) return true;
  const [row] = await query<{ available: boolean }>(
    `select to_regclass('public.requirement_clause_embeddings') is not null as available`,
    []
  );
  clauseTableSeen = row?.available === true;
  return clauseTableSeen;
}

export interface StoredClause {
  clauseIndex: number;
  content: string;
  model: string;
}

export interface ClauseEmbeddingState {
  ticketVersionId: string;
  acceptanceCriteriaText: string;
  isCurrent: boolean;
  /** The clause vectors stored for this version now, in clause order. */
  stored: StoredClause[];
}

/** One entry per id that exists in this tenant; other tenants' ids do not appear. */
export async function getClauseEmbeddingState(
  tenantId: TenantId,
  ticketVersionIds: readonly string[]
): Promise<ClauseEmbeddingState[]> {
  if (ticketVersionIds.length === 0) return [];
  const versions = await query<{
    ticketVersionId: string;
    acceptanceCriteriaText: string;
    isCurrent: boolean;
  }>(
    `select v.id as "ticketVersionId",
            v.acceptance_criteria_text as "acceptanceCriteriaText",
            ${isCurrentVersionSql('v')} as "isCurrent"
     from ticket_versions v
     where v.tenant_id = $1 and v.id = any($2::uuid[])`,
    [tenantId, [...ticketVersionIds]]
  );
  if (versions.length === 0) return [];

  const stored = await query<{ ticketVersionId: string } & StoredClause>(
    `select ticket_version_id as "ticketVersionId", clause_index as "clauseIndex",
            content, model
     from requirement_clause_embeddings
     where tenant_id = $1 and ticket_version_id = any($2::uuid[])
     order by ticket_version_id, clause_index`,
    [tenantId, versions.map((v) => v.ticketVersionId)]
  );

  return versions.map((version) => ({
    ...version,
    stored: stored
      .filter((row) => row.ticketVersionId === version.ticketVersionId)
      .map(({ clauseIndex, content, model }) => ({ clauseIndex, content, model })),
  }));
}

export interface ClauseEmbeddingWrite {
  ticketVersionId: string;
  clauses: { clauseIndex: number; content: string; embedding: readonly number[] }[];
  model: string;
}

/**
 * Replaces each given version's clause vectors as a set, in one transaction.
 *
 * Replace, not upsert: a version's clauses are one unit, and a write with fewer clauses
 * than are stored must not leave the extras behind. A version not in this tenant has
 * its delete match nothing and its inserts select nothing, so it writes no rows.
 * Returns how many versions had clauses written.
 */
export async function replaceClauseEmbeddings(
  tenantId: TenantId,
  writes: readonly ClauseEmbeddingWrite[]
): Promise<number> {
  let versionsWritten = 0;
  await tx(async (client) => {
    for (const write of writes) {
      await client.query(
        `delete from requirement_clause_embeddings
         where tenant_id = $1 and ticket_version_id = $2`,
        [tenantId, write.ticketVersionId]
      );
      let inserted = 0;
      for (const clause of write.clauses) {
        const result = await client.query(
          `insert into requirement_clause_embeddings (
             ticket_version_id, clause_index, tenant_id, content, embedding, model
           )
           select v.id, $3, v.tenant_id, $4, $5::vector, $6
           from ticket_versions v
           where v.id = $2 and v.tenant_id = $1`,
          [
            tenantId,
            write.ticketVersionId,
            clause.clauseIndex,
            clause.content,
            vectorLiteral(clause.embedding),
            write.model,
          ]
        );
        inserted += result.rowCount ?? 0;
      }
      if (inserted > 0) versionsWritten += 1;
    }
  });
  return versionsWritten;
}

/**
 * Current versions with acceptance criteria but no clause vectors — the backfill's
 * clause work list. Only "none stored" is detected here: a version's text never
 * changes, so its clauses only need re-embedding if the split or the model changes,
 * which the sync's own comparison catches when it is given the id.
 */
export async function listVersionsMissingClauseEmbeddings(
  tenantId: TenantId,
  input: { limit?: number } = {}
): Promise<{ ticketVersionId: string; title: string; acceptanceCriteriaText: string }[]> {
  return query<{ ticketVersionId: string; title: string; acceptanceCriteriaText: string }>(
    `select v.id as "ticketVersionId", v.title as "title",
            v.acceptance_criteria_text as "acceptanceCriteriaText"
     from ticket_versions v
     where v.tenant_id = $1
       and trim(both from v.acceptance_criteria_text) <> ''
       and ${isCurrentVersionSql('v')}
       and not exists (
         select 1 from requirement_clause_embeddings c
         where c.tenant_id = v.tenant_id and c.ticket_version_id = v.id
       )
     order by v.captured_at
     limit $2`,
    [tenantId, input.limit ?? 200]
  );
}

/**
 * Per stored clause of a version, the accepted scenario on that version whose vector is
 * closest. The fuzzy half of the coverage view: it suggests which scenario covers a
 * clause, and how strongly, where `covers_ac` does not say so exactly.
 *
 * Only scenario vectors still built from the scenario's current text count
 * (`e.content = s.gherkin_raw`): a vector left over from before an edit describes text
 * the reviewer replaced. Thresholds are the caller's decision.
 */
export interface ClauseMatch {
  clauseIndex: number;
  content: string;
  scenarioId: string | null;
  scenarioTitle: string | null;
  /** Cosine similarity of the best match, or null when no accepted scenario is embedded. */
  similarity: number | null;
}

export async function clauseCoverage(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<ClauseMatch[]> {
  const rows = await query<ClauseMatch & { similarity: number | string | null }>(
    `select c.clause_index as "clauseIndex",
            c.content as "content",
            best.scenario_id as "scenarioId",
            best.title as "scenarioTitle",
            best.similarity as "similarity"
     from requirement_clause_embeddings c
     left join lateral (
       select s.id as scenario_id, s.title, 1 - (e.embedding <=> c.embedding) as similarity
       from scenario_embeddings e
       join scenarios s on s.id = e.scenario_id and s.tenant_id = e.tenant_id
       where e.tenant_id = c.tenant_id
         and s.ticket_version_id = c.ticket_version_id
         and s.status in ('approved', 'edited')
         and e.content = s.gherkin_raw
       order by e.embedding <=> c.embedding
       limit 1
     ) best on true
     where c.tenant_id = $1 and c.ticket_version_id = $2
     order by c.clause_index`,
    [tenantId, ticketVersionId]
  );
  return rows.map((row) => ({
    ...row,
    similarity: row.similarity === null ? null : Number(row.similarity),
  }));
}

/**
 * The drift signal: scenarios a reviewer had accepted on an earlier version of this
 * ticket, which went stale when the text changed — each with the current version's
 * closest clause. A close match says "this probably still holds; re-review it against
 * the new wording"; no close match says "the requirement it tested may be gone".
 *
 * "Had accepted" is read from the audit trail (the last decision was approve or edit),
 * because a stale scenario's status no longer says what it was before.
 */
export interface DriftedScenario {
  scenarioId: string;
  title: string;
  ticketVersionId: string;
  /** The closest clause on the current version, or nulls when either side has no vector. */
  clauseIndex: number | null;
  clauseContent: string | null;
  similarity: number | null;
}

export async function driftedScenarios(
  tenantId: TenantId,
  input: { ticketId: string; currentVersionId: string; limit?: number }
): Promise<DriftedScenario[]> {
  const rows = await query<DriftedScenario & { similarity: number | string | null }>(
    `select s.id as "scenarioId",
            s.title as "title",
            s.ticket_version_id as "ticketVersionId",
            best.clause_index as "clauseIndex",
            best.content as "clauseContent",
            best.similarity as "similarity"
     from scenarios s
     join lateral (
       select r.decision from scenario_reviews r
       where r.tenant_id = s.tenant_id and r.scenario_id = s.id
       order by r.created_at desc
       limit 1
     ) last on last.decision in ('approved', 'edited')
     left join scenario_embeddings e
       on e.scenario_id = s.id and e.tenant_id = s.tenant_id
     left join lateral (
       select c.clause_index, c.content, 1 - (c.embedding <=> e.embedding) as similarity
       from requirement_clause_embeddings c
       where c.tenant_id = s.tenant_id and c.ticket_version_id = $3
       order by c.embedding <=> e.embedding
       limit 1
     ) best on e.scenario_id is not null
     where s.tenant_id = $1 and s.ticket_id = $2
       and s.status = 'stale'
       and s.ticket_version_id <> $3
     order by s.created_at
     limit $4`,
    [tenantId, input.ticketId, input.currentVersionId, input.limit ?? 50]
  );
  return rows.map((row) => ({
    ...row,
    similarity: row.similarity === null ? null : Number(row.similarity),
  }));
}

/** Kept exported so callers can type the rows these queries return. */
export type { QueryResultRow };
