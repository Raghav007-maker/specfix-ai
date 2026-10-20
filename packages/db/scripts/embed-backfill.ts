/**
 * Embedding backfill.
 *
 *   npm run embed:backfill -- --tenant <uuid> --dry-run
 *   npm run embed:backfill -- --tenant <uuid>
 *   npm run embed:backfill -- --tenant <uuid> --stale      re-embed drifted versions only
 *   npm run embed:backfill -- --tenant <uuid> --limit 50
 *   npm run embed:backfill -- --replay <spool file>         store a spooled run, no API calls
 *
 * Idempotent by construction: the work lists exclude anything already embedded from its
 * current text (an accepted scenario whose stored vector no longer matches its text —
 * e.g. a review-time refresh that failed — is listed again), and the writes are
 * upserts, so an interrupted run is re-run rather than repaired. The
 * cost is reported per run because embedding spend is otherwise invisible — it lands
 * in llm_calls with a zero output-token count and would read as free.
 *
 * `--dry-run` reports what would be sent and its estimated token cost without making
 * a request. That is the mode to run first against a new tenant, so the number is
 * known before it is spent.
 *
 * Each work list is embedded, its calls logged to llm_calls, and only then its vectors
 * written. When a database write fails after the API has answered (see embed-spool.ts):
 *
 *   - the calls and vectors are written to a spool file under --spool-dir, the run
 *     stops before embedding anything else, and the exit code is 2
 *   - further write runs refuse to start until that file is replayed, because a re-run
 *     would pay to embed the same rows again; `--replay` stores them without the API
 *   - if the spool file cannot be written either, the call records are printed to
 *     stderr as JSON — the only remaining copy — and the exit code is 3. The vectors
 *     are lost in that case, and a re-run would embed those rows again.
 *
 * If the database is unreachable at startup, the run fails before any API request, so
 * nothing is spent. A process killed between an API response and the write or spool
 * loses that list's records; that window is not covered.
 *
 * Exit codes: 0 ok, 1 error or failed API batches (re-run to retry them), 2 database
 * write failed and spooled, 3 database write failed and spool failed.
 */
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from '../src/client.ts';
import {
  clauseEmbeddingsAvailable,
  embeddingCounts,
  listScenariosMissingEmbeddings,
  listStaleRequirementEmbeddings,
  listVersionsMissingClauseEmbeddings,
  listVersionsMissingEmbeddings,
  recordEmbeddingCalls,
  upsertEmbeddingBatch,
} from '../src/repositories/embeddings.ts';
import { syncClauseEmbeddings } from '../src/embedding-sync.ts';
import {
  listPendingSpools,
  persistEmbeddings,
  readSpoolFile,
  replaySpool,
  writeSpoolFile,
  type PersistDeps,
  type PersistResult,
  type VectorWrites,
} from './embed-spool.ts';

// @specfix/core is a workspace package; the embedding transport lives there, not here,
// because the db package's src must not depend on an API client. Only this script does.
import {
  embedTextsTolerant,
  getConfig,
  EMBEDDING_DIMENSIONS,
  type EmbedManyOutcome,
} from '@specfix/core';

/** Repo-root `.embed-spool/`, gitignored: spool files hold tenant ticket text. */
const DEFAULT_SPOOL_DIR = fileURLToPath(new URL('../../../.embed-spool/', import.meta.url));

const EXIT_SPOOLED = 2;
const EXIT_SPOOL_FAILED = 3;

interface Args {
  tenant: string | undefined;
  dryRun: boolean;
  stale: boolean;
  limit: number;
  replay: string | undefined;
  spoolDir: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const replay = get('--replay');
  // A replay takes its tenant from the spool file; --tenant, if given, must match it.
  const tenant = get('--tenant') ?? (replay ? undefined : process.env.SPECFIX_TENANT_ID);
  if (!tenant && !replay) {
    throw new Error('--tenant <uuid> is required (or set SPECFIX_TENANT_ID)');
  }

  const limit = Number(get('--limit') ?? 200);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('--limit must be a positive integer');
  }

  return {
    tenant,
    dryRun: argv.includes('--dry-run'),
    stale: argv.includes('--stale'),
    limit,
    replay,
    spoolDir: get('--spool-dir') ?? DEFAULT_SPOOL_DIR,
  };
}

const persistDeps = (spoolDir: string): PersistDeps => ({
  recordCalls: recordEmbeddingCalls,
  writeVectors: upsertEmbeddingBatch,
  spool: (record) => writeSpoolFile(spoolDir, record),
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.replay) {
    await replay(args.replay, args.tenant);
    return;
  }

  const tenant = args.tenant as string;

  // Checked before the database or the API is touched: an unreplayed spool means rows
  // that were already paid for are still missing, and this run would embed them again.
  const pending = await listPendingSpools(args.spoolDir);
  if (pending.length && !args.dryRun) {
    throw new Error(
      `refusing to embed: ${pending.length} unreplayed spool file(s) from an earlier run ` +
        'whose database write failed. Store them first (no API calls):\n' +
        pending.map((path) => `  npm run embed:backfill -- --replay "${path}"`).join('\n')
    );
  }

  const config = getConfig();

  console.log(`tenant        : ${tenant}`);
  console.log(`embed model   : ${config.modelEmbed} (${EMBEDDING_DIMENSIONS} dims)`);
  console.log(`mode          : ${args.dryRun ? 'dry run' : 'write'}`);
  console.log(`source        : ${args.stale ? 'stale versions only' : 'missing embeddings'}`);
  if (pending.length) {
    console.log(`warning       : ${pending.length} unreplayed spool file(s) in ${args.spoolDir}`);
  }
  console.log('');

  const before = await embeddingCounts(tenant);
  console.log('before:');
  printCounts(before);
  console.log('');

  const versions = args.stale
    ? await loadStaleVersions(tenant, args.limit)
    : await listVersionsMissingEmbeddings(tenant, { limit: args.limit });
  const scenarios = args.stale
    ? []
    : await listScenariosMissingEmbeddings(tenant, { limit: args.limit });
  // Per-clause vectors need migration 0006; without it the clause pass is skipped and
  // said so, rather than failing the whole run.
  const clausesAvailable = !args.stale && (await clauseEmbeddingsAvailable());
  const clauseVersions = clausesAvailable
    ? await listVersionsMissingClauseEmbeddings(tenant, { limit: args.limit })
    : [];

  console.log(
    `work: ${versions.length} version(s), ${scenarios.length} scenario(s), ` +
      `${clauseVersions.length} version(s) needing clause vectors`
  );
  if (!args.stale && !clausesAvailable) {
    console.log('clauses: skipped — migration 0006 (requirement_clause_embeddings) not applied');
  }

  if (versions.length === 0 && scenarios.length === 0 && clauseVersions.length === 0) {
    console.log('nothing to do');
    return;
  }

  const totalChars =
    versions.reduce((sum, v) => sum + v.content.length, 0) +
    scenarios.reduce((sum, s) => sum + s.content.length, 0) +
    // Clause vectors re-send the AC text, split into clauses.
    clauseVersions.reduce((sum, v) => sum + v.acceptanceCriteriaText.length, 0);
  console.log(`estimated input tokens: ~${Math.ceil(totalChars / 4)}`);
  console.log('');

  if (args.dryRun) {
    for (const version of versions) {
      console.log(`  [version] ${version.title} — ${version.content.length} chars`);
    }
    for (const scenario of scenarios) {
      console.log(`  [scenario] ${scenario.title} — ${scenario.content.length} chars`);
    }
    for (const version of clauseVersions) {
      console.log(`  [clauses] ${version.title} — one vector per AC clause`);
    }
    console.log('');
    console.log('dry run: no request made, nothing written');
    return;
  }

  const totals = { cost: 0, tokens: 0, failedBatches: 0 };
  const deps = persistDeps(args.spoolDir);

  /**
   * Embeds one work list and persists it before the caller moves to the next: if a
   * write fails, the run stops there, so at most one list's results are ever outside
   * llm_calls. Returns false when the run must stop.
   */
  const embedAndPersist = async (
    label: string,
    contents: string[],
    toWrites: (vectors: number[][]) => VectorWrites,
    written: (counts: { requirementsWritten: number; scenariosWritten: number }) => number
  ): Promise<boolean> => {
    const outcome = await embedTextsTolerant(contents, {
      model: config.modelEmbed,
      promptVersion: 'embedding-v1',
    });
    totals.cost += outcome.totalCostUsd;
    totals.tokens += outcome.totalInputTokens;
    totals.failedBatches += outcome.failedBatches;
    reportApiFailures(outcome);

    const result = await persistEmbeddings(deps, tenant, outcome.calls, toWrites(outcome.vectors));
    if (!result.ok) {
      reportPersistFailure(label, result);
      printTotals(totals.tokens, totals.cost);
      process.exitCode = result.spoolPath ? EXIT_SPOOLED : EXIT_SPOOL_FAILED;
      return false;
    }

    console.log(
      `${label}: wrote ${written(result.written)}, ` +
        `skipped ${outcome.skippedEmpty} (blank input), ` +
        `failed ${outcome.failedIndices.length} (in ${outcome.failedBatches} failed batch(es)), ` +
        `logged ${outcome.calls.length} call(s)`
    );
    return true;
  };

  if (versions.length) {
    const ok = await embedAndPersist(
      'versions',
      versions.map((v) => v.content),
      (vectors) => ({
        requirements: versions.map((version, index) => ({
          ticketVersionId: version.ticketVersionId,
          content: version.content,
          embedding: vectors[index] ?? [],
          model: config.modelEmbed,
        })),
        scenarios: [],
      }),
      (counts) => counts.requirementsWritten
    );
    if (!ok) return;
  }

  if (scenarios.length) {
    const ok = await embedAndPersist(
      'scenarios',
      scenarios.map((s) => s.content),
      (vectors) => ({
        requirements: [],
        scenarios: scenarios.map((scenario, index) => ({
          scenarioId: scenario.scenarioId,
          content: scenario.content,
          embedding: vectors[index] ?? [],
          model: config.modelEmbed,
        })),
      }),
      (counts) => counts.scenariosWritten
    );
    if (!ok) return;
  }

  // Clause vectors go through the same lifecycle sync ingest uses (embedding-sync.ts),
  // not the spool path: a clause failure is reported and its version stays on the work
  // list for the next run. If llm_calls refuses the call records, they are printed
  // below as the only copy and no clause vectors are stored.
  if (clauseVersions.length) {
    const result = await syncClauseEmbeddings(
      tenant,
      clauseVersions.map((version) => version.ticketVersionId),
      { embed: embedTextsTolerant, model: config.modelEmbed }
    );
    totals.cost += result.calls.reduce((sum, call) => sum + call.costUsd, 0);
    totals.tokens += result.calls.reduce((sum, call) => sum + call.inputTokens, 0);

    const titleFor = new Map(clauseVersions.map((v) => [v.ticketVersionId, v.title]));
    let written = 0;
    for (const { id, outcome } of result.outcomes) {
      if (outcome.status === 'embedded') written += 1;
      if (outcome.status === 'failed') {
        totals.failedBatches += 1;
        console.error(
          `  clauses failed for ${titleFor.get(id) ?? id}: ${outcome.stage}: ${outcome.error}`
        );
      }
    }
    console.log(`clauses: wrote ${written} version(s), logged ${result.calls.length} call(s)`);
    if (result.callLogError !== null && result.calls.length > 0) {
      console.error(
        `llm_calls insert failed (${result.callLogError}); clause vectors not stored. ` +
          'Unlogged call records follow as JSON — keep them:'
      );
      console.error(JSON.stringify({ tenantId: tenant, calls: result.calls }));
    }
  }

  printTotals(totals.tokens, totals.cost);

  const after = await embeddingCounts(tenant);
  console.log('after:');
  printCounts(after);

  // Failed rows are still missing, so a re-run picks them up; the exit code says one
  // is needed rather than letting a partial backfill look like a clean one. Their
  // failed calls are already in llm_calls.
  if (totals.failedBatches > 0) {
    console.error(`${totals.failedBatches} API batch(es) failed; re-run to retry the missing rows`);
    process.exitCode = 1;
  }
}

async function replay(path: string, expectedTenant: string | undefined): Promise<void> {
  console.log(`replaying     : ${path}`);
  console.log('mode          : database writes only, no API calls');
  console.log('');

  // Checked before anything is written, so a wrong --tenant cannot half-apply a spool.
  const spooled = await readSpoolFile(path);
  if (expectedTenant && expectedTenant !== spooled.tenantId) {
    throw new Error(
      `spool belongs to tenant ${spooled.tenantId}, not --tenant ${expectedTenant}; nothing written`
    );
  }

  const result = await replaySpool(
    { recordCalls: recordEmbeddingCalls, writeVectors: upsertEmbeddingBatch },
    path
  ).catch((error: unknown) => {
    throw new Error(
      `replay failed: ${errorMessage(error)}\n` +
        'The spool file is unchanged except that its calls are marked logged once ' +
        'they are inserted, so it is safe to replay again.'
    );
  });

  console.log(`tenant        : ${result.tenantId}`);
  console.log(`calls logged  : ${result.callsRecorded}`);
  console.log(`requirements  : ${result.written.requirementsWritten}`);
  console.log(`scenarios     : ${result.written.scenariosWritten}`);
  console.log(`spool renamed : ${result.replayedPath}`);
}

function reportApiFailures(outcome: EmbedManyOutcome): void {
  for (const call of outcome.calls) {
    if (call.error !== null) console.error(`  API batch failed: ${call.error}`);
  }
}

function reportPersistFailure(label: string, result: Extract<PersistResult, { ok: false }>): void {
  const what =
    result.failedStage === 'record_calls'
      ? 'logging embedding calls to llm_calls'
      : 'writing vectors (calls were logged)';
  console.error('');
  console.error(`${label}: database write failed while ${what}: ${errorMessage(result.error)}`);

  if (result.spoolPath) {
    console.error(
      `  spooled ${result.record.calls.length} call record(s) and ` +
        `${result.record.writes.requirements.length + result.record.writes.scenarios.length} ` +
        `vector(s) to:\n    ${result.spoolPath}`
    );
    console.error('  stopped before embedding anything else. Once the database is reachable:');
    console.error(`    npm run embed:backfill -- --replay "${result.spoolPath}"`);
    console.error('  write runs are refused until then, so these rows are not paid for twice.');
    return;
  }

  console.error(`  the spool file could not be written either: ${errorMessage(result.spoolError)}`);
  if (result.callsLogged) {
    console.error('  the call records are already in llm_calls; the vectors are lost.');
  } else {
    console.error('  call records follow as JSON — this is the only copy, keep it:');
    console.error(JSON.stringify({ tenantId: result.record.tenantId, calls: result.record.calls }));
  }
  console.error('  a re-run will embed these rows again.');
}

function printCounts(counts: Awaited<ReturnType<typeof embeddingCounts>>): void {
  console.log(`  requirement vectors   : ${counts.requirements}`);
  console.log(`  scenario vectors      : ${counts.scenarios}`);
  console.log(`  versions awaiting     : ${counts.versionsAwaiting}`);
  console.log(`  scenarios awaiting    : ${counts.scenariosAwaiting}`);
}

function printTotals(tokens: number, cost: number): void {
  console.log('');
  console.log(`tokens: ${tokens}`);
  console.log(`cost  : $${cost.toFixed(4)}`);
  console.log('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stale versions are re-embedded with the *current* text, which is what the
 * comparison in `listStaleRequirementEmbeddings` already fetched. They arrive in a
 * different shape from the missing-versions list, so they are mapped here rather
 * than widening that function's return type into a union.
 */
async function loadStaleVersions(
  tenantId: string,
  limit: number
): Promise<{ ticketVersionId: string; title: string; content: string }[]> {
  const stale = await listStaleRequirementEmbeddings(tenantId, { limit });
  if (stale.length === 0) return [];

  // The title is only used for reporting, so it is fetched with one query keyed on the
  // ids already in hand rather than joined into the staleness check itself.
  const ids = stale.map((row) => row.ticketVersionId);
  const { rows } = await getPool().query<{ id: string; title: string }>(
    `select id, title from ticket_versions where tenant_id = $1 and id = any($2::uuid[])`,
    [tenantId, ids]
  );
  const titles = new Map(rows.map((row) => [row.id, row.title]));

  return stale.map((row) => ({
    ticketVersionId: row.ticketVersionId,
    title: titles.get(row.ticketVersionId) ?? '(unknown)',
    content: row.currentContent,
  }));
}

main()
  .then(async () => {
    await closePool();
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closePool().catch(() => {});
    process.exit(1);
  });
