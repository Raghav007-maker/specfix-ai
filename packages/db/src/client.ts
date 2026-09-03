/**
 * Database access.
 *
 * The rule this module exists to enforce: every tenant-scoped query carries an
 * explicit tenant_id predicate, supplied by the caller. RLS does not save us here
 * because the worker connects with the Supabase service-role key, which bypasses
 * it. So isolation is a property of this layer, verified by
 * packages/db/test/tenant-isolation.test.ts.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set.');
    }
    const isRemote = !/localhost|127\.0\.0\.1/.test(connectionString);
    pool = new Pool({
      connectionString,
      max: Number(process.env.PGPOOL_MAX ?? 10),
      // Supabase's pooler drops idle connections; fail fast rather than hang.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: isRemote ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** A tenant id, wrapped so it cannot be silently confused with any other string. */
export type TenantId = string;

export async function query<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as unknown[]);
  return result.rows;
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` with auth.uid() bound to `userId` for the duration of one
 * transaction, so RLS policies apply. Used by tests and by any code path that
 * should be subject to RLS rather than trusted above it.
 */
export async function asUser<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return tx(async (client) => {
    await client.query('select set_config($1, $2, true)', ['specfix.test_user_id', userId]);
    return fn(client);
  });
}
