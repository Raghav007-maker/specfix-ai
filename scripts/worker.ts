/**
 * Background worker: drains the sync_jobs queue (Jira imports, analysis batches).
 *
 *   npm run worker
 *
 * Runs until Ctrl+C. Safe to run more than one: jobs are claimed with SKIP LOCKED.
 * Stopping mid-job is safe too — the job's lease lapses and the next worker resumes it
 * from its last checkpoint.
 */
import 'dotenv/config';
import { closePool } from '@specfix/db';
import { runWorker } from '@specfix/sync';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}: finishing the current job, then stopping`);
    controller.abort();
  });
}

console.log('specfix worker: waiting for jobs');
await runWorker({ signal: controller.signal });
await closePool();
