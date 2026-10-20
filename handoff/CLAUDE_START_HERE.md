# Instructions for Claude Pro: Start Here

Welcome to the **SpecFix** project. This document is your mandatory entry point. It contains all the necessary operational rules, architectural constraints, repository status, and instructions to continue Phase 2 development smoothly without access to previous chat history.

---

## 1. Operating Rules & Core Constraints

Before inspecting or writing code, internalize these non-negotiable rules:

1. **Do Not Discard or Overwrite Existing Work:**
   * There are staged, unstaged, and untracked changes in the working tree. **Do not run `git reset`, `git checkout .`, `git clean`, or `git restore`.**
   * Do not commit anything automatically without user approval.
2. **Never Expose Secrets:**
   * Never output, log, or commit API keys, tokens, passwords, or connection strings from `.env`. Reference environment variable names only.
3. **Never Run Destructive Database Commands:**
   * Do not run `--reset` migrations against any remote database. Migration `0004_embeddings.sql` is already applied in the remote database.
4. **Implement One Small Task at a Time:**
   * Do not attempt to implement all of Phase 2 at once. Propose changes for one specific task, explain your rationale, and wait for the user's approval before modifying files.
5. **Human Gate Principle:**
   * A human review gate exists after every AI-generated artifact. The code must never auto-resolve flags, auto-approve scenarios, or auto-apply test scaffolds without explicit human sign-off.
6. **Tenant Isolation Invariant:**
   * Every database table has `tenant_id`. Every repository function takes `tenantId: TenantId` as its first parameter. No raw SQL queries in `apps/*`.

---

## 2. Project & Phase 2 Overview

* **What SpecFix Is:** An automated specification analysis and quality platform. It ingests software requirements, identifies ambiguity and edge cases via LLM analysis, deliberates with an adversarial Critic pass, and presents flags for PM review.
* **What Phase 2 Is:** Extends the platform from ambiguity detection into **Specflow & Traceability**:
  1. Compiling approved requirements and resolved clarifications into Gherkin scenarios.
  2. Emitting deterministic Playwright test scaffolds with placeholder locators.
  3. Building a traceability graph using pgvector embeddings (`text-embedding-3-small`, 1536 dimensions) for fuzzy coverage and specification drift detection.

---

## 3. Current Verified Repository State

* **Active Branch:** `shrikant` (tracks `origin/shrikant`)
* **HEAD Commit:** `8a7a076` (*"phase-2 implementation"*, Oct 13, 2026)
* **Status Summary:**
  * **Milestone A (Spec Compiler Core):** **Complete** in [packages/compiler](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler).
  * **Milestone B (Scenario Review UI):** **Complete** in [apps/web/app/tickets/[ticketId]/specs](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs).
  * **Milestone C (Playwright Scaffold Emitter):** **Complete** in [packages/compiler/src/scaffold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scaffold.ts).
  * **Milestone D (Traceability & Embeddings):** **Partially Complete**. Transport and repository exist in untracked files, but embedding call logging is missing, lifecycle triggers are absent, and the Specs UI lacks the fuzzy coverage view.
  * **Milestone E (Generation Evaluation):** **Partially Complete**. Evaluation metrics and CLI runner exist, but baseline evaluation reports are not yet committed.
  * **Milestone F (Conversational Resolution Agent):** **Pending** (optional).

### Key Files You Must Be Aware Of
* **Untracked Files:**
  * `packages/core/src/embeddings.ts` (Embedding client, batching, and cosine similarity)
  * `packages/db/migrations/0004_embeddings.sql` (Already applied to remote DB; adds `'embed'` to `llm_calls` and HNSW indexes)
  * `packages/db/src/repositories/embeddings.ts` (Embedding CRUD, staleness queries, nearest-neighbor searches)
  * `packages/db/scripts/embed-backfill.ts` (CLI backfill script)
  * `scripts/probe-azure.mjs` (Diagnostic probe for Azure OpenAI)
* **Uncommitted Modifications:**
  * `packages/core/src/openai.ts`, `config.ts`, `cost.ts`: Added Azure OpenAI support and embedding cost accounting.
  * `packages/db/src/client.ts`: Increased connection timeout to 30s.
  * `apps/web/*`: Performance optimizations (parallel `Promise.all` queries, React `cache()` for auth session).

---

## 4. Your First Task: Embedding Call Logging & Unit Tests

### What Needs to Be Done
Currently, when embedding calls are made via `embedTexts` or `embed-backfill.ts`, call metadata (`EmbeddingCallRecord`) is calculated but **discarded instead of being logged to `llm_calls`**. This breaks the invariant that all LLM spend is audited. Furthermore, `packages/core/src/embeddings.ts` has no unit tests.

### Exact Files to Inspect Before Modifying
1. [packages/core/src/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts) — Review `EmbeddingCallRecord` and `embedTexts`.
2. [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts) — Note existing repository pattern and imports.
3. [packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts) — Review how `outcome = await embedTextsTolerant(...)` is handled.
4. [packages/db/migrations/0004_embeddings.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0004_embeddings.sql) — Note that `purpose in (..., 'embed')` is valid in `llm_calls`.

### Acceptance Criteria for Task 1
1. Add `recordEmbeddingCalls(tenantId, calls)` to [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts). It must insert records into `llm_calls` with `purpose = 'embed'`, `analysis_run_id = null`, and `compile_run_id = null`.
2. Wire `recordEmbeddingCalls` into [packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts) so calls are stored during backfills.
3. Create `packages/core/test/embeddings.test.ts` testing `cosineSimilarity`, `toVectorLiteral`, `EmbeddingDimensionError`, and batch structure offline.
4. Verify tests pass with `npx vitest run packages/core/test/embeddings.test.ts`.
5. Verify TypeScript compiles cleanly with `npm run typecheck`.

---

## 5. Subsequent Implementation Roadmap

Once Task 1 is approved and completed:
1. **Task 2: Ingestion & Review Sync** — Wire requirement embedding generation into `ingestTicket` and scenario embedding generation into `decideScenario`.
2. **Task 3: Safe Embedding Backfill** — Run `embed-backfill.ts` across the active workspace to populate vectors for the existing 15 tickets and 19 scenarios.
3. **Task 4: Specs UI Fuzzy Coverage & Drift** — Connect `nearestScenarios` to `apps/web/app/tickets/[ticketId]/specs/` and render similarity scores in `CoveragePanel`.
4. **Task 5: Generation Eval Baseline** — Run `npm run eval -- generate --set gold-v1 --prompt compile-gherkin-v1` and commit the baseline report to `fixtures/eval-runs/`.

---

## 6. Verification Commands

Always run these commands to verify code correctness:
```bash
# 1. Typecheck
npm run typecheck

# 2. Run unit tests
npx vitest run

# 3. Check git status to ensure only intended files were modified
git status
```
