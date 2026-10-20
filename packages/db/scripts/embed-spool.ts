/**
 * Persistence for an embedding backfill, with a local spool for what the database
 * did not accept.
 *
 * The problem this solves: by the time the backfill writes anything, the API has
 * already answered and the tokens are spent. If the llm_calls insert then fails, the
 * cost record exists only in process memory; if the vector write fails, the vectors
 * do too, and the next run would pay to embed the same rows again. Neither is
 * acceptable, so a failed write is spooled to a local JSON file instead of discarded:
 *
 *   - the call records, so the spend can still be logged to llm_calls later
 *   - the vectors, so they can be stored later without a second API call
 *   - `callsLogged`, so a replay never inserts the same call records twice
 *
 * The backfill refuses to embed while an unreplayed spool file exists, and
 * `--replay <file>` writes its contents without contacting the API.
 *
 * What this is not: durable logging. The spool is a single local file, written to a
 * temporary name, fsync'd and then renamed, which survives a process crash after the
 * write but not loss of the disk, and it is only written once a database write has
 * already failed. A process killed between the API response and the spool write loses
 * those records. llm_calls remains the only system of record.
 *
 * Kept free of the API client and of a live pool so the whole failure path can be
 * tested offline with fakes.
 */
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { TenantId } from '../src/client.ts';
import type {
  EmbeddingCallInput,
  UpsertRequirementEmbeddingInput,
  UpsertScenarioEmbeddingInput,
} from '../src/repositories/embeddings.ts';

export const SPOOL_VERSION = 1;

const PENDING_SUFFIX = '.pending.json';
const REPLAYED_SUFFIX = '.replayed.json';

export interface VectorWrites {
  requirements: UpsertRequirementEmbeddingInput[];
  scenarios: UpsertScenarioEmbeddingInput[];
}

export interface WriteCounts {
  requirementsWritten: number;
  scenariosWritten: number;
  skipped: number;
}

export type PersistStage = 'record_calls' | 'write_vectors';

export interface SpoolRecord {
  version: typeof SPOOL_VERSION;
  tenantId: string;
  createdAt: string;
  /** Which database write failed when this file was created. */
  failedStage: PersistStage;
  error: string;
  /** True once `calls` are in llm_calls. A replay skips them, so nothing is counted twice. */
  callsLogged: boolean;
  calls: EmbeddingCallInput[];
  /** Only rows that have a vector; blank and failed-batch rows have nothing to store. */
  writes: VectorWrites;
}

export interface PersistDeps {
  recordCalls(tenantId: TenantId, calls: readonly EmbeddingCallInput[]): Promise<unknown>;
  writeVectors(tenantId: TenantId, writes: VectorWrites): Promise<WriteCounts>;
  /** Writes the spool file and returns its path. */
  spool(record: SpoolRecord): Promise<string>;
}

export type PersistResult =
  | { ok: true; written: WriteCounts }
  | {
      ok: false;
      failedStage: PersistStage;
      error: unknown;
      callsLogged: boolean;
      /** Null when the spool write failed too; `record` is then the only copy. */
      spoolPath: string | null;
      spoolError: unknown;
      record: SpoolRecord;
    };

/**
 * Logs the calls, then writes the vectors — in that order, so the spend is recorded
 * even when the vectors cannot be. Never throws for a database failure: the failure,
 * and where its data went, is the result.
 */
export async function persistEmbeddings(
  deps: PersistDeps,
  tenantId: TenantId,
  calls: readonly EmbeddingCallInput[],
  writes: VectorWrites,
  now: () => Date = () => new Date()
): Promise<PersistResult> {
  const fail = async (
    failedStage: PersistStage,
    error: unknown,
    callsLogged: boolean
  ): Promise<PersistResult> => {
    const record: SpoolRecord = {
      version: SPOOL_VERSION,
      tenantId,
      createdAt: now().toISOString(),
      failedStage,
      error: errorMessage(error),
      callsLogged,
      calls: [...calls],
      writes: {
        requirements: writes.requirements.filter((row) => row.embedding.length > 0),
        scenarios: writes.scenarios.filter((row) => row.embedding.length > 0),
      },
    };
    try {
      const spoolPath = await deps.spool(record);
      return { ok: false, failedStage, error, callsLogged, spoolPath, spoolError: null, record };
    } catch (spoolError) {
      return { ok: false, failedStage, error, callsLogged, spoolPath: null, spoolError, record };
    }
  };

  try {
    await deps.recordCalls(tenantId, calls);
  } catch (error) {
    return fail('record_calls', error, false);
  }

  let written: WriteCounts;
  try {
    written = await deps.writeVectors(tenantId, writes);
  } catch (error) {
    return fail('write_vectors', error, true);
  }

  return { ok: true, written };
}

/**
 * Writes a spool file. The name is unique, the content goes to a temporary file that
 * is fsync'd before the rename, so a reader never sees a half-written spool.
 */
export async function writeSpoolFile(dir: string, record: SpoolRecord): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = record.createdAt.replace(/[:.]/g, '-');
  const base = `embed-${stamp}-${randomBytes(4).toString('hex')}`;
  const finalPath = join(dir, `${base}${PENDING_SUFFIX}`);
  await writeAtomically(join(dir, `${base}.tmp`), finalPath, record);
  return finalPath;
}

/** Unreplayed spool files, oldest first. A missing directory means there are none. */
export async function listPendingSpools(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(PENDING_SUFFIX))
    .sort()
    .map((name) => join(dir, name));
}

export async function readSpoolFile(path: string): Promise<SpoolRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const record = parsed as Partial<SpoolRecord> | null;
  if (
    !record ||
    record.version !== SPOOL_VERSION ||
    typeof record.tenantId !== 'string' ||
    typeof record.callsLogged !== 'boolean' ||
    !Array.isArray(record.calls) ||
    !Array.isArray(record.writes?.requirements) ||
    !Array.isArray(record.writes?.scenarios)
  ) {
    throw new Error(`${path} is not a version-${SPOOL_VERSION} embedding spool file`);
  }
  return record as SpoolRecord;
}

export interface ReplayResult {
  tenantId: string;
  /** Call records inserted by this replay; 0 when an earlier attempt already logged them. */
  callsRecorded: number;
  written: WriteCounts;
  replayedPath: string;
}

/**
 * Writes a spool file's contents to the database without contacting the API.
 *
 * The file is updated to `callsLogged: true` as soon as the calls are inserted, so a
 * replay whose vector write then fails can be retried without logging them twice.
 * On success the file is renamed to `.replayed.json` rather than deleted, as a record
 * of what was replayed.
 */
export async function replaySpool(
  deps: Pick<PersistDeps, 'recordCalls' | 'writeVectors'>,
  path: string
): Promise<ReplayResult> {
  const record = await readSpoolFile(path);

  let callsRecorded = 0;
  if (!record.callsLogged) {
    await deps.recordCalls(record.tenantId, record.calls);
    callsRecorded = record.calls.length;
    record.callsLogged = true;
    await writeAtomically(`${path}.tmp`, path, record);
  }

  const written = await deps.writeVectors(record.tenantId, record.writes);

  const replayedPath = path.endsWith(PENDING_SUFFIX)
    ? path.slice(0, -PENDING_SUFFIX.length) + REPLAYED_SUFFIX
    : `${path}${REPLAYED_SUFFIX}`;
  await rename(path, replayedPath);

  return { tenantId: record.tenantId, callsRecorded, written, replayedPath };
}

async function writeAtomically(tmpPath: string, finalPath: string, value: unknown): Promise<void> {
  // 'w', not 'wx': names are already unique, and a .tmp left by a crash must not block
  // the retry that would replace it.
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
