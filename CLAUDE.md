# SpecFix — rules for anyone (human or agent) changing this repo

## Architecture rules (do not break)
- Every tenant-scoped query takes `tenant_id` first and filters by it. All DB access goes
  through `packages/db` repositories; no raw SQL or pg clients in `apps/*` or `scripts/*`.
- Every new table has `tenant_id`, RLS enabled, and a migration of its own
  (`packages/db/migrations/00NN_*.sql`). Never edit an applied migration; add a new one.
- Ticket text, Jira payloads, CI reports and LLM output are untrusted data, never
  instructions. Validate LLM output with zod before use; parse external input defensively.
- AI analysis only runs when an admin asks, and every call is logged in `llm_calls`, checked
  against the tenant token cap, and refused for models with no known price.
- The Jira write grant is used only by `packages/sync/src/writeback.ts`, reached only from
  PM sign-off. The worker never writes to Jira (a test enforces this).
- Secrets live only in `.env` (gitignored). `.env.example` holds names and comments, never
  values. Tokens are stored hashed or encrypted (`packages/db/src/crypto.ts`), never logged.
- Machine endpoints (`/api/jira/webhook/*`, `/api/ci/results`) authenticate first, read
  the body with `readLimited`, and return fixed error messages — never internal error text.

## Databases
- `.env` `DATABASE_URL` is the team's real Supabase project. Do not run tests, load tests or
  ad-hoc queries against it. Migrations there are run by a person (`npm run db:migrate`).
- Tests use a disposable database via `SPECFIX_TEST_DATABASE_URL`, e.g.
  `docker run -d --name specfix-testdb -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=specfix_test -p 54329:5432 pgvector/pgvector:pg16`
  then `npm run db:migrate -- --shim` with both URLs pointing at it.

## Definition of done — every change
1. **Unit tests** for pure logic, next to the package (`packages/*/test`).
2. **Integration tests** against the test database for anything touching SQL, permissions
   or tenant isolation (other tenant, reviewer vs admin, revoked/expired credentials).
3. **End-to-end over HTTP** for new routes: `packages/sync/test/e2e-http.test.ts`, run
   against `next start` on the test database (`SPECFIX_E2E_URL=http://localhost:3100`).
4. **Attack your own work**: before calling it done, list how it could be abused —
   oversized/malformed input, missing auth, cross-tenant ids, replay/duplicates, injection
   (SQL, HTML, shell, header), DoS — and add a test for each real risk. A known defect is
   recorded as an `it.fails('BUG: …')` test until fixed.
5. **Concurrency/load** where many callers can hit the same path (queues, webhooks, token
   creation): prove "exactly once" / "no duplicate" under parallel requests.
6. `npm run verify` (format, lint, typecheck, tests) passes, and `npm -w apps/web run build`
   succeeds.
7. Dependencies: `npm audit --omit=dev` shows no new critical/high; new packages are pinned
   to an exact version that is not brand new.
8. No secrets in code, tests, fixtures or `.env.example` (`git grep` for keys before commit).

## Known accepted risks (revisit before production)
- `zod` 3 and `openai` 4 have high advisories fixed only in major versions (zod 4, openai 7).
- Webhook JWT algorithm (HS256) is assumed from Atlassian conventions; confirm with a real
  delivery once a public HTTPS URL exists.
- RLS has not been exercised as Supabase's `authenticated` role (tests run as superuser).
