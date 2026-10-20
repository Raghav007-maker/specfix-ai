# Git and Database State: SpecFix

This document records the exact, verified state of the Git repository and the PostgreSQL database as of **October 20, 2026**.

---

## 1. Git Repository State

### Active Branch & Commit
* **Current Branch:** `shrikant`
* **Upstream Branch:** `origin/shrikant` (local branch is up to date with remote)
* **HEAD Commit:** `8a7a076de131472906a4477cf98b1247c933bbf8`
* **Commit Date:** Tue Oct 13 12:00:18 2026 +0530
* **Commit Author:** Shrikant-sharma-9 <shrikantsharma20052005@gmail.com>
* **Commit Message:** `phase-2 implementation`

### Recent Commit History
```
8a7a076 - Shrikant-sharma-9, 7 days ago : phase-2 implementation (2026-10-13 12:00:18 +0530)
a49dc4a - Raghav bansal, 3 weeks ago : feat: implement core configuration, token cost accounting, and OpenAI transport modules (2026-09-30 11:49:26 +0530)
be1cba9 - Raghav bansal, 4 weeks ago : chore: add validation gold set raw ticket fixtures in markdown and docx formats (2026-09-24 19:23:21 +0530)
3c51d32 - Raghav bansal, 4 weeks ago : fix(core): commit missing critic-v1 prompt file (2026-09-24 19:15:50 +0530)
8f62057 - Raghav bansal, 4 weeks ago : feat: add core analysis engine, evaluation harness, database layer, and web application (2026-09-24 18:59:52 +0530)
```

---

## 2. Working Directory & Uncommitted Changes

### Staged Files
* `modified: packages/core/src/openai.ts`
  * Added `import OpenAI, { AzureOpenAI } from 'openai';` to support Azure OpenAI client initialization.

### Unstaged Modified Files
1. **[packages/core/src/config.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/config.ts):**
   * Added `azureEndpoint`, `azureApiVersion` to `ConfigSchema`.
   * Added detection logic for Azure OpenAI endpoints (`rawAzureEndpoint` or `azure.com` substring in `OPENAI_BASE_URL`).
   * Configured fallback model resolution from `OPENAI_MODEL_EXTRACT` for extract, judge, and compile passes.
   * Updated `hasOpenAiCredentials()` to return true if `OPENAI_API_KEY` or `AZURE_OPENAI_API_KEY` is present.
2. **[packages/core/src/cost.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/cost.ts):**
   * Added model pricing for `gpt-5.4-mini`, `5.4-mini`, `gpt-5.6-mini` ($0.15 / 1M in, $0.60 / 1M out).
   * Added pricing for `text-embedding-3-small` ($0.02 / 1M in, $0.00 / 1M out).
3. **[packages/core/src/openai.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/openai.ts):**
   * Updated `getClient()` to initialize `new AzureOpenAI(...)` when `config.azureEndpoint` is defined.
4. **[packages/core/src/index.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/index.ts):**
   * Exported `embeddings.ts` via `export * from './embeddings.ts';`.
5. **[packages/db/src/client.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/client.ts):**
   * Increased connection timeout: `connectionTimeoutMillis: Number(process.env.PG_TIMEOUT_MS ?? 30_000)` to prevent connection drops on cold Supabase pooler starts.
6. **[packages/db/src/index.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/index.ts):**
   * Exported `repositories/embeddings.ts` via `export * from './repositories/embeddings.ts';`.
7. **[apps/web/app/(auth)/actions.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/(auth)/actions.ts):**
   * Replaced immediate throw on sign-up failure with redirection containing user-friendly error query parameters.
8. **[apps/web/app/page.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/page.tsx):**
   * Parallelized membership loading and query parameter resolution via `Promise.all`.
9. **[apps/web/app/tickets/[ticketId]/page.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/page.tsx):**
   * Parallelized ticket data fetches (`listGaps`, `revealedFlags`, `listDecisionsForTicket`, `readinessTimeline`, `listRunsForTicket`) using `Promise.all` while maintaining blind-first review gating.
10. **[apps/web/lib/session.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/lib/session.ts):**
    * Wrapped `getUser()` in React `cache()` to eliminate redundant auth server round-trips within a single request render.
11. **[apps/web/lib/tenant.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/lib/tenant.ts):**
    * Added optional `memberships` parameter to `currentTenant()` and `requireTenant()` to avoid duplicate membership queries.
12. **[apps/web/middleware.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/middleware.ts):**
    * Expanded matcher exclusion pattern to ignore font and style assets (`woff`, `woff2`, `css`, `map`).
13. **[package-lock.json](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/package-lock.json):**
    * Synchronized `@specfix/compiler` dependency in `@specfix/eval`.

### Untracked Files
* **[packages/core/src/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts):** Embedding transport and batching client (`embedTexts`, `embedText`, `embedTextsTolerant`, `cosineSimilarity`).
* **[packages/db/migrations/0004_embeddings.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0004_embeddings.sql):** Database migration adding `'embed'` purpose to `llm_calls` and HNSW vector cosine indexes.
* **[packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts):** pgvector CRUD and nearest-neighbor search queries.
* **[packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts):** CLI script for backfilling vectors on existing ticket versions and scenarios.
* **[scripts/probe-azure.mjs](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/scripts/probe-azure.mjs):** Standalone diagnostic testing Azure OpenAI connectivity, JSON schema response format, and 1536-dim embedding generation.

---

## 3. Database State & Migrations

### Migration Files & Status
The runner at [packages/db/scripts/migrate.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/migrate.ts) applies migrations in ascending filename order, tracked in the table `schema_migrations`.

| Migration File | Tracked in Git? | Applied to Live DB? | Applied Timestamp |
| :--- | :---: | :---: | :--- |
| `0001_init.sql` | Yes | **Yes** | `2026-08-31 17:39:03 UTC` |
| `0002_deliberation.sql` | Yes | **Yes** | `2026-09-30 05:45:57 UTC` |
| `0003_specs.sql` | Yes | **Yes** | `2026-10-15 07:20:33 UTC` |
| `0004_embeddings.sql` | **No (Untracked)** | **Yes** | `2026-10-16 12:00:13 UTC` |

### Critical Divergence Note
Migration `0004_embeddings.sql` is **already applied** to the active Supabase PostgreSQL database, but the `.sql` file remains untracked in Git. Running `npm run db:migrate` against this database correctly reports `nothing to apply` because `0004_embeddings.sql` is recorded in `schema_migrations`. However, a fresh developer clone or CI environment running `npm run db:migrate` would not have `0004_embeddings.sql` unless it is tracked in Git.

### Live Database Entity Counts
Verified via read-only SQL query on the active database:
* `tickets`: 15
* `ticket_versions`: 15
* `scenarios`: 19
* `test_scaffolds`: 0
* `requirement_embeddings`: **0**
* `scenario_embeddings`: **0**

---

## 4. State Verification Commands

To verify the repository and database state independently without making changes, execute:

```bash
# 1. Check Git status and working directory
git status
git log -n 3 --oneline

# 2. Check TypeScript compilation across all workspaces
npm run typecheck

# 3. Check offline test suite (skipping DB-dependent tests)
npx vitest run

# 4. Verify applied database migrations (read-only)
node -r dotenv/config -e "import('pg').then(async ({ default: { Client } }) => { const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); const res = await c.query('select * from schema_migrations order by name'); console.log(res.rows); await c.end(); })"

# 5. Check live table counts (read-only)
node -r dotenv/config -e "import('pg').then(async ({ default: { Client } }) => { const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); const res = await c.query('select count(*) from requirement_embeddings; select count(*) from scenario_embeddings;'); console.log(res.map(r => r.rows)); await c.end(); })"
```
