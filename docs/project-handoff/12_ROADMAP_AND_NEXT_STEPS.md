# 12 — Roadmap & Next Steps

This document provides a prioritized engineering roadmap for completing Phase 2 and stabilizing the SpecFix platform.

> **Notice:** This roadmap is a technical plan and does not constitute authorization to implement changes. Each task must be approved by the project owner before execution.

---

## P0 — Immediate Blockers

### Task P0-1: Implement Embedding Call Logging & Unit Tests
* **Objective:** Ensure all embedding API requests are recorded in `llm_calls` with token counts, latency, and costs, and establish unit test coverage.
* **Reason:** Restores compliance with the system logging invariant and establishes baseline test coverage for the untracked embedding transport.
* **Relevant Files:**
  * `packages/db/src/repositories/embeddings.ts`
  * `packages/db/scripts/embed-backfill.ts`
  * `packages/core/test/embeddings.test.ts` (new)
* **Dependencies:** None.
* **Acceptance Criteria:**
  1. `recordEmbeddingCalls(tenantId, calls)` is implemented in `repositories/embeddings.ts`.
  2. `embed-backfill.ts` passes `outcome.calls` to `recordEmbeddingCalls`.
  3. `packages/core/test/embeddings.test.ts` passes with 100% test success.
  4. `npm run typecheck` passes with zero errors.
* **Risks:** Minimal. Additive changes only.
* **Human Approval Required?** No (standard bug fix).

### Task P0-2: Commit Untracked Phase 2 Files
* **Objective:** Stage and commit `packages/core/src/embeddings.ts`, `packages/db/migrations/0004_embeddings.sql`, `packages/db/src/repositories/embeddings.ts`, and `packages/db/scripts/embed-backfill.ts`.
* **Reason:** Prevents CI failure on fresh clones and secures working changes in Git history.
* **Dependencies:** Completion of Task P0-1.
* **Human Approval Required?** **Yes** (Git commit requires user authorization).

---

## P1 — Reliability & Data Integrity

### Task P1-1: Handle Azure Content Filter in Adversarial Injection Test
* **Objective:** Update `packages/compiler/test/injection.test.ts` to catch Azure OpenAI content filter rejections (HTTP 400).
* **Reason:** Eliminates the single failing test in the Vitest suite when running on Azure OpenAI.
* **Relevant Files:** `packages/compiler/test/injection.test.ts`.
* **Dependencies:** None.
* **Acceptance Criteria:** `npx vitest run packages/compiler/test/injection.test.ts` passes cleanly.
* **Human Approval Required?** No.

### Task P1-2: Wire Embedding Lifecycle Sync into Ingestion & Reviews
* **Objective:** Trigger requirement embeddings on ticket ingestion and scenario embeddings on scenario approval/edit.
* **Reason:** Eliminates manual CLI backfilling as the only method for vector generation.
* **Relevant Files:**
  * `packages/db/src/repositories/tickets.ts` (`ingestTicket`)
  * `packages/db/src/repositories/scenarios.ts` (`decideScenario`)
* **Dependencies:** Task P0-1.
* **Acceptance Criteria:**
  1. Ingesting a new ticket creates a corresponding row in `requirement_embeddings`.
  2. Approving or editing a scenario creates or refreshes a row in `scenario_embeddings`.
* **Human Approval Required?** Yes (alters write behavior on live paths).

### Task P1-3: Execute Safe Embedding Backfill on Production Database
* **Objective:** Populate vectors for the existing 15 tickets and 19 scenarios currently stored in Supabase.
* **Reason:** Enables semantic vector search on historical tickets.
* **Relevant Files:** `packages/db/scripts/embed-backfill.ts`.
* **Dependencies:** Tasks P0-1 and P1-2.
* **Acceptance Criteria:**
  1. Dry-run verified before execution.
  2. `requirement_embeddings` contains 15 rows; `scenario_embeddings` contains rows for approved scenarios.
  3. `llm_calls` reflects all backfill API calls.
* **Human Approval Required?** **Yes** (incurs API cost).

---

## P2 — Core Product Implementation (Milestone D & E Completion)

### Task P2-1: Implement Semantic Fuzzy Coverage UI on Specs Tab
* **Objective:** Render semantic similarity scores between acceptance criteria and accepted scenarios in `CoveragePanel`.
* **Reason:** Completes Milestone D by providing the visual fuzzy coverage view promised in `specfix-phase2-plan.md`.
* **Relevant Files:**
  * `apps/web/app/tickets/[ticketId]/specs/page.tsx`
  * `apps/web/app/tickets/[ticketId]/specs/specs.tsx`
* **Dependencies:** Task P1-3.
* **Acceptance Criteria:**
  1. Reviewers see semantic similarity percentages alongside relational counts.
  2. Candidate scenarios matching an AC clause above a cosine floor (e.g. 0.6) are highlighted.
  3. Drift warnings appear when ticket text changes under approved specs.
* **Human Approval Required?** Yes.

### Task P2-2: Run and Commit Baseline Generation Evaluation (Milestone E)
* **Objective:** Execute `npm run eval -- generate --set gold-v1 --prompt compile-gherkin-v1` and commit the baseline report to `fixtures/eval-runs/`.
* **Reason:** Establishes the auditable quality baseline for Gherkin scenario generation.
* **Relevant Files:** `fixtures/eval-runs/gold-v1__compile-gherkin-v1.json`.
* **Dependencies:** Task P0-1.
* **Human Approval Required?** Yes.

---

## P3 — Operational Readiness & Tooling

### Task P3-1: Enable CI Automated Database Migrations
* **Objective:** Ensure CI executes `npm run db:migrate -- --shim` with migration `0004_embeddings.sql` included.
* **Dependencies:** Task P0-2.

### Task P3-2: Finalize Gold Set Labels (§0 Housekeeping)
* **Objective:** Populate `fixtures/gold/gold-v1.json` with team reviewer labels and set `"frozen": true`.
* **Dependencies:** Human reviewer data provided by project owner.
