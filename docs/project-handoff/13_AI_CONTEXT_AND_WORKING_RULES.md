# 13 — AI Context & Working Rules

This document provides essential instructions, operating guidelines, and safety constraints for any AI coding assistant continuing work on **SpecFix**.

---

## 1. Operating Principles & Golden Rules

1. **Never Discard Working Tree Changes:**
   * The working directory currently contains staged, unstaged, and untracked files representing critical uncommitted work (Azure OpenAI support, embedding transport, performance optimizations).
   * **Never execute:** `git reset`, `git checkout .`, `git restore .`, `git clean -f`, or `git stash drop`.
2. **Never Expose Secrets:**
   * Never print, log, or commit secret keys, passwords, database URLs, or API tokens from `.env`. Reference variable names only.
3. **Never Run Destructive Database Commands:**
   * Never run `npm run db:reset` or execute `drop schema` against any remote database. Migration `0004_embeddings.sql` is already applied in production.
4. **Implement One Task at a Time:**
   * Do not attempt large multi-file refactors in a single turn. Propose small, focused edits, explain the rationale, and wait for human confirmation before writing files.
5. **Preserve Human Gates:**
   * Never write autonomous loops that auto-approve flags, auto-accept scenarios, or auto-apply test code without explicit PM interaction.

---

## 2. Monorepo Conventions & Boundaries

* **No Cross-Package Circular Imports:**
  * Packages form a strict DAG: `shared` ← `ingest`, `core` ← `compiler` ← `db` ← `apps/web`.
  * `packages/core` must **never** import from `packages/db`.
  * `packages/compiler` must **never** import from `packages/db`.
* **Database Access Constraint:**
  * In `apps/web`, all database queries must go through `apps/web/lib/repos.ts` (which re-exports `@specfix/db` behind `'server-only'`).
  * Never write direct SQL queries in frontend components.
* **Tenant Isolation Invariant:**
  * Every repository function in `packages/db/src/repositories/` must accept `tenantId: TenantId` as its first parameter and include `tenant_id = $1` in all SQL clauses.
* **Typing & Linting Discipline:**
  * Run `npm run typecheck` after every edit. The codebase maintains strict TypeScript mode with zero compiler errors.
  * Use GitHub-style markdown file links with `file:///` URI scheme when discussing source files.

---

## 3. Important Source File Paths

| Responsibility | File Path |
| :--- | :--- |
| **OpenAI / Azure Transport** | [packages/core/src/openai.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/openai.ts) |
| **Configuration & Models** | [packages/core/src/config.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/config.ts) |
| **Token Cost Accounting** | [packages/core/src/cost.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/cost.ts) |
| **Embedding Client** | [packages/core/src/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts) |
| **Spec Compiler Core** | [packages/compiler/src/scenario.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scenario.ts) |
| **Playwright Scaffold Emitter** | [packages/compiler/src/scaffold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scaffold.ts) |
| **Database Repositories** | [packages/db/src/repositories/](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/) |
| **Specs Tab Server Actions** | [apps/web/app/tickets/[ticketId]/specs/actions.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/actions.ts) |
| **Specs Dashboard View** | [apps/web/app/tickets/[ticketId]/specs/specs.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/specs.tsx) |

---

## 4. How to Approach Your First Task

The recommended first task is **Task P0-1: Embedding Call Logging & Unit Tests**:

1. **Step 1:** Read [packages/core/src/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts) to understand `EmbeddingCallRecord`.
2. **Step 2:** Inspect [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts) and add:
   ```typescript
   export async function recordEmbeddingCalls(
     tenantId: TenantId,
     calls: readonly EmbeddingCallRecord[]
   ): Promise<void>
   ```
3. **Step 3:** Wire `recordEmbeddingCalls` into `packages/db/scripts/embed-backfill.ts`.
4. **Step 4:** Add unit tests in `packages/core/test/embeddings.test.ts` testing `cosineSimilarity`, `toVectorLiteral`, and `EmbeddingDimensionError` offline.
5. **Step 5:** Run `npm run typecheck` and `npx vitest run packages/core/test/embeddings.test.ts` to verify.
6. **Step 6:** Stop, report actual test output, and await user approval before proceeding.
