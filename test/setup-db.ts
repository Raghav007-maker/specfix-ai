/**
 * Keeps the destructive integration suites away from the database the app runs on.
 *
 * vitest loads `.env`, and `.env` holds live credentials. The pg-backed suites are not
 * read-only: they create tenants, auth.users rows, projects, tickets, flags and
 * labeling sessions on every run. If they ever picked up the app's DATABASE_URL they
 * would write fixtures into the real project — and the recall/precision numbers Week 3
 * exists to produce are computed by scanning those same tables.
 *
 * Gating on `DATABASE_URL` cannot express the distinction, because the variable is the
 * same one either way. So the suites get their own: SPECFIX_TEST_DATABASE_URL, which
 * must be set deliberately and should only ever name a disposable database. CI points
 * it at its postgres:16 service.
 *
 * This file runs before any test module is imported, so by the time `getPool()` can be
 * reached, DATABASE_URL either *is* the test database or does not exist — and not
 * existing makes `getPool()` throw rather than quietly connect somewhere real.
 */
const testUrl = process.env.SPECFIX_TEST_DATABASE_URL;

if (testUrl) {
  process.env.DATABASE_URL = testUrl;
} else {
  delete process.env.DATABASE_URL;
}
