/**
 * Migration runner.
 *
 * Applies packages/db/migrations/*.sql in filename order, once each, tracked in
 * schema_migrations. Deliberately dumb: no down-migrations, no branching. At this
 * stage a bad migration is fixed by a new migration, or by --reset locally.
 *
 *   npm run db:migrate              apply pending migrations
 *   npm run db:migrate -- --shim    apply the auth shim first (local/CI only)
 *   npm run db:reset -- --shim      drop everything, then apply from scratch
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');
const shimPath = join(here, '..', 'test', 'auth-shim.sql');

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const reset = args.has('--reset');
  const withShim = args.has('--shim');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    if (reset) {
      // Guard: refuse to reset anything that looks like a deployed database.
      if (!/localhost|127\.0\.0\.1|host\.docker\.internal/.test(connectionString)) {
        throw new Error(
          '--reset refused: DATABASE_URL does not point at localhost. ' +
            'Reset is a local-only operation.'
        );
      }
      console.log('resetting public and auth schemas');
      await client.query('drop schema if exists public cascade');
      await client.query('drop schema if exists auth cascade');
      await client.query('create schema public');
    }

    if (withShim) {
      console.log('applying auth shim');
      await client.query(await readFile(shimPath, 'utf8'));
    }

    await client.query(`
      create table if not exists schema_migrations (
        name       text        primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (r) => r.name
      )
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      console.log(`applying ${file}`);
      // Each migration is one transaction: it applies fully or not at all.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        count += 1;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    console.log(count === 0 ? 'nothing to apply' : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
