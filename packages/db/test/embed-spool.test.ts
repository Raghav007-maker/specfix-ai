/**
 * The backfill's failure path, tested without a database.
 *
 * Every database write is a fake, and spool files go to a throwaway temp directory.
 * What is under test is the ordering and the bookkeeping that keep embedding spend
 * from being lost or double-counted: calls are logged before vectors are written, a
 * failed write is spooled rather than dropped, and a replay never logs the same calls
 * twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPendingSpools,
  persistEmbeddings,
  readSpoolFile,
  replaySpool,
  writeSpoolFile,
  SPOOL_VERSION,
  type PersistDeps,
  type SpoolRecord,
  type VectorWrites,
} from '../scripts/embed-spool.ts';
import type { EmbeddingCallInput } from '../src/repositories/embeddings.ts';

const TENANT = '00000000-0000-4000-8000-000000000001';
const FIXED_NOW = () => new Date('2026-10-20T12:00:00.000Z');

const call = (overrides: Partial<EmbeddingCallInput> = {}): EmbeddingCallInput => ({
  promptVersion: 'embedding-v1',
  model: 'text-embedding-3-small',
  request: { inputCount: 2, inputTokensEstimated: 10 },
  response: { model: 'text-embedding-3-small', dimensions: 1536 },
  latencyMs: 12,
  inputTokens: 10,
  outputTokens: 0,
  costUsd: 0.0000002,
  error: null,
  ...overrides,
});

const writes = (): VectorWrites => ({
  requirements: [
    { ticketVersionId: 'v1', content: 'AC one', embedding: [0.1, 0.2], model: 'm' },
    // A blank or failed-batch row: nothing to store, so it must not be spooled.
    { ticketVersionId: 'v2', content: '', embedding: [], model: 'm' },
  ],
  scenarios: [],
});

const COUNTS = { requirementsWritten: 1, scenariosWritten: 0, skipped: 1 };

function fakeDeps(overrides: Partial<PersistDeps> = {}) {
  const order: string[] = [];
  const spooled: SpoolRecord[] = [];
  const deps: PersistDeps = {
    recordCalls: vi.fn(async () => {
      order.push('recordCalls');
    }),
    writeVectors: vi.fn(async () => {
      order.push('writeVectors');
      return COUNTS;
    }),
    spool: vi.fn(async (record: SpoolRecord) => {
      order.push('spool');
      spooled.push(record);
      return '/spool/file.pending.json';
    }),
    ...overrides,
  };
  return { deps, order, spooled };
}

describe('persistEmbeddings', () => {
  it('logs the calls before writing the vectors, and spools nothing on success', async () => {
    const { deps, order } = fakeDeps();
    const calls = [call(), call({ error: 'boom', inputTokens: 0, costUsd: 0 })];

    const result = await persistEmbeddings(deps, TENANT, calls, writes(), FIXED_NOW);

    expect(result).toEqual({ ok: true, written: COUNTS });
    expect(order).toEqual(['recordCalls', 'writeVectors']);
    // Failed API calls are logged with the rest, not filtered out.
    expect(deps.recordCalls).toHaveBeenCalledWith(TENANT, calls);
  });

  it('does not write vectors when logging fails, and spools calls and vectors', async () => {
    const { deps, order, spooled } = fakeDeps({
      recordCalls: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const calls = [call()];

    const result = await persistEmbeddings(deps, TENANT, calls, writes(), FIXED_NOW);

    expect(order).toEqual(['spool']);
    expect(deps.writeVectors).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      failedStage: 'record_calls',
      callsLogged: false,
      spoolPath: '/spool/file.pending.json',
      spoolError: null,
    });
    expect(spooled).toHaveLength(1);
    expect(spooled[0]).toEqual({
      version: SPOOL_VERSION,
      tenantId: TENANT,
      createdAt: '2026-10-20T12:00:00.000Z',
      failedStage: 'record_calls',
      error: 'connection refused',
      callsLogged: false,
      calls,
      writes: {
        requirements: [
          { ticketVersionId: 'v1', content: 'AC one', embedding: [0.1, 0.2], model: 'm' },
        ],
        scenarios: [],
      },
    });
  });

  it('spools the vectors with callsLogged when only the vector write fails', async () => {
    const { deps, order, spooled } = fakeDeps({
      writeVectors: vi.fn(async () => {
        throw new Error('deadlock detected');
      }),
    });

    const result = await persistEmbeddings(deps, TENANT, [call()], writes(), FIXED_NOW);

    expect(order).toEqual(['recordCalls', 'spool']);
    expect(result).toMatchObject({ ok: false, failedStage: 'write_vectors', callsLogged: true });
    expect(spooled[0]?.callsLogged).toBe(true);
    expect(spooled[0]?.error).toBe('deadlock detected');
  });

  it('returns the records in memory when the spool write fails too', async () => {
    const { deps } = fakeDeps({
      recordCalls: vi.fn(async () => {
        throw new Error('connection refused');
      }),
      spool: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const calls = [call()];

    const result = await persistEmbeddings(deps, TENANT, calls, writes(), FIXED_NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.spoolPath).toBeNull();
    expect((result.spoolError as Error).message).toBe('EACCES');
    // The caller prints these; they must still be here.
    expect(result.record.calls).toEqual(calls);
  });
});

describe('spool files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'specfix-spool-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = (overrides: Partial<SpoolRecord> = {}): SpoolRecord => ({
    version: SPOOL_VERSION,
    tenantId: TENANT,
    createdAt: '2026-10-20T12:00:00.000Z',
    failedStage: 'record_calls',
    error: 'connection refused',
    callsLogged: false,
    calls: [call()],
    writes: {
      requirements: [{ ticketVersionId: 'v1', content: 'AC', embedding: [0.5], model: 'm' }],
      scenarios: [{ scenarioId: 's1', content: 'Scenario: x', embedding: [0.25], model: 'm' }],
    },
    ...overrides,
  });

  it('round-trips a record and lists it as pending, leaving no temp file', async () => {
    const path = await writeSpoolFile(dir, record());

    expect(path.endsWith('.pending.json')).toBe(true);
    expect(await listPendingSpools(dir)).toEqual([path]);
    expect(await readSpoolFile(path)).toEqual(record());
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a missing spool directory as having nothing pending', async () => {
    expect(await listPendingSpools(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('rejects a file that is not a spool record', async () => {
    const path = join(dir, 'junk.pending.json');
    await writeFile(path, JSON.stringify({ version: 99, calls: [] }));
    await expect(readSpoolFile(path)).rejects.toThrow(/not a version-1 embedding spool file/);
  });

  it('replays calls then vectors, and retires the file', async () => {
    const path = await writeSpoolFile(dir, record());
    const order: string[] = [];
    const deps = {
      recordCalls: vi.fn(async () => {
        order.push('recordCalls');
      }),
      writeVectors: vi.fn(async () => {
        order.push('writeVectors');
        return { requirementsWritten: 1, scenariosWritten: 1, skipped: 0 };
      }),
    };

    const result = await replaySpool(deps, path);

    expect(order).toEqual(['recordCalls', 'writeVectors']);
    expect(deps.recordCalls).toHaveBeenCalledWith(TENANT, record().calls);
    expect(deps.writeVectors).toHaveBeenCalledWith(TENANT, record().writes);
    expect(result.callsRecorded).toBe(1);
    expect(result.replayedPath.endsWith('.replayed.json')).toBe(true);
    expect(await listPendingSpools(dir)).toEqual([]);
    expect(JSON.parse(await readFile(result.replayedPath, 'utf8')).callsLogged).toBe(true);
  });

  it('skips the calls on replay when they were already logged', async () => {
    const path = await writeSpoolFile(
      dir,
      record({ failedStage: 'write_vectors', callsLogged: true })
    );
    const deps = {
      recordCalls: vi.fn(async () => {}),
      writeVectors: vi.fn(async () => ({
        requirementsWritten: 1,
        scenariosWritten: 1,
        skipped: 0,
      })),
    };

    const result = await replaySpool(deps, path);

    expect(deps.recordCalls).not.toHaveBeenCalled();
    expect(result.callsRecorded).toBe(0);
  });

  it('keeps the file pending but marks calls logged when the vector write fails mid-replay', async () => {
    const path = await writeSpoolFile(dir, record());
    const recordCalls = vi.fn(async () => {});
    const failing = {
      recordCalls,
      writeVectors: vi.fn(async () => {
        throw new Error('still down');
      }),
    };

    await expect(replaySpool(failing, path)).rejects.toThrow('still down');
    expect(await listPendingSpools(dir)).toEqual([path]);
    expect((await readSpoolFile(path)).callsLogged).toBe(true);

    // The retry writes the vectors without logging the calls a second time.
    const retry = {
      recordCalls,
      writeVectors: vi.fn(async () => ({
        requirementsWritten: 1,
        scenariosWritten: 1,
        skipped: 0,
      })),
    };
    await replaySpool(retry, path);
    expect(recordCalls).toHaveBeenCalledTimes(1);
  });
});
