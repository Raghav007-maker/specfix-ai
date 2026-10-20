# 11 — Findings & Risks Register

This document registers all confirmed defects, technical risks, architectural gaps, and uncertainties identified during the repository audit, ordered by severity.

---

## 1. High & Critical Severity Findings

### FINDING-01: Embedding API Calls Are Never Logged to `llm_calls`
* **ID:** `F-01`
* **Severity:** **High** (System Invariant Violation)
* **Category:** Logging & Cost Accountability
* **Description:** Migration `0004_embeddings.sql` added `'embed'` to `llm_calls_purpose_check`. In `packages/core/src/embeddings.ts`, `embedTexts()` calculates latency, input tokens, and cost. However, `packages/db/src/repositories/embeddings.ts` contains no function to insert embedding calls into `llm_calls`. In `packages/db/scripts/embed-backfill.ts`, `outcome.calls` are discarded.
* **Evidence:**
  * [packages/db/migrations/0004_embeddings.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0004_embeddings.sql#L29-L31)
  * [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts) (no reference to `llm_calls`)
  * [packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts#L115-L156) (`outcome.calls` unused)
* **Impact:** Embedding API spend is invisible in the database. Monthly token cap accounting fails to include embedding spend.
* **Verification:** Run `embed-backfill.ts` and query `select * from llm_calls where purpose = 'embed'`. Zero rows returned.
* **Recommended Action:** Add `recordEmbeddingCalls(tenantId, calls)` to `repositories/embeddings.ts` and call it in `embed-backfill.ts`.
* **Human Approval Required?** No (standard bug fix).

---

### FINDING-02: Untracked Key Phase 2 Implementation Files
* **ID:** `F-02`
* **Severity:** **High** (Version Control & Build Reproducibility Risk)
* **Category:** Version Control & CI/CD
* **Description:** Four critical Phase 2 embedding files exist in the working directory but remain untracked in Git:
  * `packages/core/src/embeddings.ts`
  * `packages/db/migrations/0004_embeddings.sql`
  * `packages/db/src/repositories/embeddings.ts`
  * `packages/db/scripts/embed-backfill.ts`
* **Evidence:** `git status --short` displays `??` for these files.
* **Impact:** Any fresh clone or automated CI pipeline will fail TypeScript compilation (`@specfix/core` cannot export `embeddings.ts`, and `@specfix/db` cannot export `repositories/embeddings.ts`). Furthermore, fresh database migrations will not apply migration 0004.
* **Verification:** Run `git status` in a clean terminal.
* **Recommended Action:** Review, stage, and commit these files after adding call logging and unit tests.
* **Human Approval Required?** Yes (requires user approval to commit).

---

### FINDING-03: Azure OpenAI Content Filter Fails Adversarial Injection Test
* **ID:** `F-03`
* **Severity:** **Medium** (Test Suite Blocker)
* **Category:** Test Suite & AI Provider Compatibility
* **Description:** `npx vitest run packages/compiler/test/injection.test.ts` fails with HTTP 400: `The response was filtered due to the prompt triggering Azure OpenAI's content management policy`. The simulated prompt injection attack in `fixtures/tickets/adversarial/injection-03-ac-instructions.md` triggers Azure's automated content safety filter.
* **Evidence:** Test execution output of `task-144`.
* **Impact:** Monorepo test suite cannot achieve 100% green status on Azure OpenAI.
* **Verification:** Run `npx vitest run packages/compiler/test/injection.test.ts`.
* **Recommended Action:** Update the live test to catch Azure content management filtering errors specifically, asserting that Azure rejected the injection safely.
* **Human Approval Required?** No.

---

### FINDING-04: Disconnected Embedding Lifecycle & Empty Database Tables
* **ID:** `F-04`
* **Severity:** **Medium** (Feature Incompleteness)
* **Category:** Pipeline Integration
* **Description:** Ingesting a ticket (`ingestTicket`) does not generate requirement embeddings. Approving or editing a scenario (`decideScenario`) does not generate scenario embeddings. Consequently, the live database currently contains 15 tickets and 19 scenarios, but **0 rows** in `requirement_embeddings` and `scenario_embeddings`.
* **Evidence:** SQL query `select count(*) from requirement_embeddings` returns `0`.
* **Impact:** Semantic vector search and drift detection are completely inactive in production.
* **Verification:** Query live database counts via Node pg client.
* **Recommended Action:** Connect `embedText` triggers to `ingestTicket` and `decideScenario`, and run the backfill script across existing records.
* **Human Approval Required?** Yes (backfill execution incurs API cost).

---

## 2. Low & Informational Findings

### FINDING-05: Missing Dedicated Embedding Unit Tests
* **ID:** `F-05`
* **Severity:** **Low** (Quality Gap)
* **Category:** Testing
* **Description:** While `packages/core/src/embeddings.ts` contains mathematical logic (`cosineSimilarity`, `toVectorLiteral`) and batching logic, there are zero automated tests covering it in `packages/core/test/`.
* **Recommended Action:** Create `packages/core/test/embeddings.test.ts`.

### FINDING-06: Ineffective Query Semantics in `nearestRequirements`
* **ID:** `F-06`
* **Severity:** **Low** (Design Redundancy)
* **Category:** Database Query Logic
* **Description:** In `packages/db/src/repositories/embeddings.ts`, `nearestRequirements` filters by `r.ticket_version_id = $2`. Because `ticket_version_id` is the primary key of `requirement_embeddings`, the query can only ever match 1 row.
* **Recommended Action:** Document that multi-candidate ranking is performed by `nearestScenarios`, or chunk requirements if clause-level ranking is required.

### FINDING-07: Unfrozen Gold Set Fixture (§0 Housekeeping)
* **ID:** `F-07`
* **Severity:** **Informational** (Evaluation Hygiene)
* **Category:** Evaluation & Metrics
* **Description:** `fixtures/gold/gold-v1.json` has `"frozen": false` and empty `gaps: []` and `verdicts: []`. The team's verbal validation has not been committed to the repository.
* **Recommended Action:** Populate reviewer labels and set `"frozen": true` when available.
