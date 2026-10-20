# 15 — Investigation Log

This document records the exact steps, file inspections, and non-destructive terminal checks performed during the repository audit on **October 20, 2026**.

---

## 1. File & Directory Inspections

### 1. Root & Workspace Configurations
* Inspected `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc.json`.
* Inspected `.github/workflows/ci.yml`.
* Inspected `test/setup-db.ts`.

### 2. Plans & Architecture Specifications
* Inspected `README.md`.
* Inspected `specfix-implementation-plan.md` (Phases 0–1, wedge definition, validation gates).
* Inspected `specfix-phase2-plan.md` (Milestones A–F, Gherkin/Playwright scaffolds, traceability, pgvector).

### 3. Application Code (`apps/web`)
* Inspected `apps/web/package.json`, `next.config.ts`, `middleware.ts`.
* Inspected `apps/web/lib/repos.ts`, `session.ts`, `tenant.ts`.
* Inspected `apps/web/app/tickets/[ticketId]/page.tsx`, `actions.ts`, `stages.tsx`.
* Inspected `apps/web/app/tickets/[ticketId]/specs/page.tsx`, `actions.ts`, `specs.tsx`.
* Inspected `apps/web/app/tickets/[ticketId]/specs/download/[scaffoldId]/route.ts`.

### 4. Packages (`packages/*`)
* `packages/compiler`: `schema.ts`, `scaffold.ts`, `scenario.ts`, `prompts/compile-gherkin-v1.md`, `test/compiler.test.ts`, `test/injection.test.ts`.
* `packages/core`: `config.ts`, `cost.ts`, `openai.ts`, `analyze.ts`, `deliberate.ts`, `embeddings.ts`, `prompts/single-shot-v1.md`, `prompts/critic-v1.md`.
* `packages/db`: `client.ts`, `migrations/0001_init.sql`, `migrations/0002_deliberation.sql`, `migrations/0003_specs.sql`, `migrations/0004_embeddings.sql`, `scripts/migrate.ts`, `scripts/embed-backfill.ts`, and all repository files.
* `packages/shared`: `schema.ts`, `scenario.ts`.
* `packages/eval`: `generation.ts`, `generate-run.ts`, `gold.ts`, `score.ts`, `control.ts`, `cli.ts`.
* `packages/ingest`: `markdown.ts`, `csv.ts`, `file-source.ts`.

---

## 2. Terminal Commands Executed & Verified Results

### 1. Git State Inspection
* **Command:** `git status; git branch -v; git log -n 5 --pretty=format:"%h - %an, %ar : %s (%ci)"`
* **Output:** Branch `shrikant` up to date with `origin/shrikant`. Latest commit `8a7a076` on Oct 13, 2026. Multiple modified files and untracked files confirmed.

### 2. TypeScript Compilation Check
* **Command:** `npm run typecheck`
* **Output:** Clean pass (exit code 0). Zero TypeScript errors across all workspaces.

### 3. Unit & Integration Test Suite Run
* **Command:** `npx vitest run`
* **Output:** 13 passed, 1 failed, 1 skipped test file (176 passed, 1 failed, 28 skipped).
* **Finding:** Delimiter containment and offline suites pass. Live adversarial injection test failed on Azure OpenAI content moderation filter. DB tests safely skipped due to `test/setup-db.ts` guardrail.

### 4. Diagnostic Connectivity Check
* **Command:** `node scripts/probe-azure.mjs`
* **Output:** Verified chat completion (`gpt-5.4-mini`), JSON schema response format, and 1536-dimensional embeddings (`text-embedding-3-small`). All 3 checks passed cleanly.

### 5. Read-Only Database Migrations Audit
* **Command:** `node -r dotenv/config -e "import('pg').then(async ({ default: { Client } }) => { const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); const res = await c.query('select * from schema_migrations order by name'); console.log(res.rows); await c.end(); })"`
* **Output:** Confirmed migrations 0001, 0002, 0003, and 0004 applied to remote database.

### 6. Read-Only Entity Count Query
* **Command:** `node -r dotenv/config -e "import('pg').then(async ({ default: { Client } }) => { const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); const res = await c.query('select (select count(*) from tickets) as tickets, (select count(*) from ticket_versions) as versions, (select count(*) from scenarios) as scenarios, (select count(*) from test_scaffolds) as scaffolds, (select count(*) from requirement_embeddings) as req_embed, (select count(*) from scenario_embeddings) as scen_embed'); console.log(res.rows[0]); await c.end(); })"`
* **Output:** `{ tickets: '15', versions: '15', scenarios: '19', scaffolds: '0', req_embed: '0', scen_embed: '0' }`.

---

## 3. Checks NOT Performed (And Rationale)

* **No Database Migrations Run:** Running migrations could mutate the remote database. Only read-only queries were issued.
* **No Embedding Backfills Run:** Running backfills would call external AI APIs and write vectors to the database without explicit user approval.
* **No Git Commits or Resets:** Staged, unstaged, and untracked files were preserved untouched.
* **No Source Code Edits:** All application code was kept unmodified.
