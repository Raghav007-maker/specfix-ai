# Known Issues & Next Steps: SpecFix Engineering Backlog

This backlog outlines the verified pending tasks, bugs, and gaps in Phase 2, ordered by technical dependency and safety.

---

## 1. Verified Bugs & Technical Blockers

### Issue 1: Missing LLM Call Logging for Embeddings
* **Severity / Priority:** **P0 — Critical Invariant Violation**
* **Location:** [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts), [packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts).
* **Problem:** Migration `0004_embeddings.sql` added `'embed'` to the `llm_calls_purpose_check` constraint. However, neither `repositories/embeddings.ts` nor `embed-backfill.ts` writes embedding call records to `llm_calls`. In `embed-backfill.ts`, `outcome.calls` are discarded. This violates the core system invariant that all model spend must be logged in `llm_calls` with token counts, latency, and costs.
* **Resolution:** Add `recordEmbeddingCalls(tenantId, calls)` to `packages/db/src/repositories/embeddings.ts` and call it in `embed-backfill.ts`.

### Issue 2: Azure Content Filter Policy Failure on Adversarial Injection Test
* **Severity / Priority:** **P1 — CI / Test Suite Blocker**
* **Location:** [packages/compiler/test/injection.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/test/injection.test.ts#L70-L104).
* **Problem:** When running `npx vitest run`, the live test `compiles scenarios instead of emitting the injected code` fails with:
  `Error: 400 The response was filtered due to the prompt triggering Azure OpenAI's content management policy.`
  Azure OpenAI's content moderation detects simulated attack strings (e.g. `SYSTEM OVERRIDE`, `PWNED-COMPILER`) in [injection-03-ac-instructions.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/fixtures/tickets/adversarial/injection-03-ac-instructions.md) and blocks the request.
* **Resolution:** Catch Azure content management filtering specifically (HTTP status 400 with code `content_filter`) in the test runner, asserting that the content filter rejected the injection without violating schema, or rephrase the adversarial payload to avoid tripping safety heuristics while preserving delimiter attack testing.

### Issue 3: Ineffective Query Semantics in `nearestRequirements`
* **Severity / Priority:** **P2 — Design Flaw in Untracked Module**
* **Location:** [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts#L339-L359).
* **Problem:** `nearestRequirements` queries `where r.tenant_id = $1 and r.ticket_version_id = $2`. Because `ticket_version_id` is the primary key in `requirement_embeddings`, there is at most one row for that version. Ordering by cosine distance with `limit 5` is redundant and cannot find multiple nearest requirements within the same version.
* **Resolution:** Document that multi-item ranking is performed by `nearestScenarios` (which ranks multiple scenarios against a requirement embedding), or chunk requirements by acceptance criteria clause if clause-level ranking is required.

---

## 2. Actionable Implementation Backlog

### Task 1: Embedding API Call Logging & Unit Tests (Immediate Next Step)
* **Priority:** **P0 (Smallest Safe Task)**
* **Why Necessary:** Restores compliance with the project's model call logging invariant and establishes automated test coverage for the untracked embedding transport.
* **Relevant Files:**
  * [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts)
  * [packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts)
  * `packages/core/test/embeddings.test.ts` (new file)
* **Dependencies:** None.
* **Implementation Approach:**
  1. Define `EmbeddingCallInput` in `repositories/embeddings.ts` matching `EmbeddingCallRecord` from `@specfix/core`.
  2. Implement `recordEmbeddingCalls(tenantId: TenantId, calls: readonly EmbeddingCallInput[]): Promise<void>` executing parameterized inserts into `llm_calls` with `analysis_run_id = null`, `compile_run_id = null`, and `purpose = 'embed'`.
  3. Call `recordEmbeddingCalls` in `embed-backfill.ts` when `--dry-run` is false.
  4. Create `packages/core/test/embeddings.test.ts` to test `cosineSimilarity`, `toVectorLiteral`, `EmbeddingDimensionError`, and `embedTexts` structure (mocking API client).
* **Acceptance Criteria:**
  * `npm run typecheck` passes with zero errors.
  * `npx vitest run packages/core/test/embeddings.test.ts` passes 100%.
  * `embed-backfill.ts` successfully logs call records when executed.

---

### Task 2: Lifecycle Embedding Sync (Ingestion & Review Integration)
* **Priority:** **P1**
* **Why Necessary:** Currently, embeddings can only be generated by manually executing a CLI script. They should be created automatically during the application lifecycle.
* **Relevant Files:**
  * [packages/db/src/repositories/tickets.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/tickets.ts) (`ingestTicket`)
  * [packages/db/src/repositories/scenarios.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/scenarios.ts) (`decideScenario`, `recordCompilation`)
* **Dependencies:** Task 1.
* **Implementation Approach:**
  * In `ingestTicket`, when a new `ticket_versions` record is created, invoke `embedText` for the combined acceptance criteria and description, then call `upsertRequirementEmbedding`.
  * In `decideScenario`, when a scenario transitions to `approved` or `edited`, invoke `embedText` on `scenario.gherkin_raw` and call `upsertScenarioEmbedding`.
* **Acceptance Criteria:**
  * Ingesting a new ticket creates a row in `requirement_embeddings`.
  * Approving or editing a scenario creates or updates a row in `scenario_embeddings`.
  * All embedding calls log to `llm_calls`.

---

### Task 3: Safe Backfill of Existing Database Records
* **Priority:** **P1**
* **Why Necessary:** The active database contains 15 ticket versions and 19 scenarios, but 0 embeddings in `requirement_embeddings` and `scenario_embeddings`.
* **Relevant Files:**
  * [packages/db/scripts/embed-backfill.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/scripts/embed-backfill.ts)
* **Dependencies:** Tasks 1 and 2.
* **Implementation Approach:**
  1. Run `npx tsx packages/db/scripts/embed-backfill.ts --tenant <SPECFIX_TENANT_ID> --dry-run` to audit token cost before spending.
  2. Execute the backfill without `--dry-run`.
  3. Verify `requirement_embeddings` has 15 rows and `scenario_embeddings` has rows corresponding to approved/edited scenarios.
* **Acceptance Criteria:**
  * `embeddingCounts(tenantId)` reports 0 versions awaiting and 0 scenarios awaiting.
  * Costs and token usage are visible in `llm_calls`.

---

### Task 4: Semantic Fuzzy Coverage & Drift Indicators in Specs UI
* **Priority:** **P2 (Milestone D Completion)**
* **Why Necessary:** Milestone D promises semantic fuzzy coverage ("which AC clause has no scenario?") and drift alerts ("this ticket version changed; which approved scenarios are suspect?"). The current UI only displays hard relational links.
* **Relevant Files:**
  * [apps/web/app/tickets/[ticketId]/specs/page.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/page.tsx)
  * [apps/web/app/tickets/[ticketId]/specs/specs.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/specs.tsx) (`CoveragePanel`)
  * [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts) (`nearestScenarios`, `listStaleRequirementEmbeddings`)
* **Dependencies:** Tasks 1, 2, and 3.
* **Implementation Approach:**
  * In `SpecsPage`, load the requirement vector and retrieve top candidate scenarios via `nearestScenarios(tenantId, { embedding, ticketVersionId, minSimilarity: 0.6 })`.
  * Display a "Semantic Coverage & Similarity" card in `CoveragePanel` indicating candidate matches between acceptance criteria and accepted scenarios.
  * If `countStaleScenariosForTicket > 0` or `listStaleRequirementEmbeddings` detects text drift, surface an explicit warning badge alerting the PM that specs are out of sync with updated ticket text.
* **Acceptance Criteria:**
  * Reviewer sees semantic similarity percentage alongside hard-link coverage.
  * Stale specification warnings display when ticket text is modified.

---

### Task 5: Baseline Generation Evaluation (Milestone E Completion)
* **Priority:** **P2**
* **Why Necessary:** Milestone E requires automated evaluation of Gherkin scenario generation against committed baselines. Currently, no generation report exists in `fixtures/eval-runs/`.
* **Relevant Files:**
  * [packages/eval/src/cli.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/cli.ts)
  * [packages/eval/src/generate-run.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/generate-run.ts)
  * `fixtures/eval-runs/gold-v1__compile-gherkin-v1.json` (to be generated)
* **Dependencies:** Task 1.
* **Implementation Approach:**
  1. Run `npm run eval -- generate --set gold-v1 --prompt compile-gherkin-v1`.
  2. Verify that acceptance metrics, hallucinated-cover rate, and scaffold validity are calculated.
  3. Commit the resulting JSON report to `fixtures/eval-runs/`.
* **Acceptance Criteria:**
  * Baseline report committed in `fixtures/eval-runs/`.
  * `npm run eval -- show --set gold-v1 --prompt compile-gherkin-v1` renders the report.

---

## 3. Recommended Implementation Order

```
[ Task 1: Embedding Call Logging & Unit Tests ] (Smallest safe task, no DB risk)
                        │
                        ▼
[ Task 2: Lifecycle Embedding Sync (Ingest & Review) ]
                        │
                        ▼
[ Task 3: Safe Backfill of Existing Database Records ]
                        │
                        ▼
[ Task 4: Semantic Fuzzy Coverage & Drift Indicators in Specs UI ]
                        │
                        ▼
[ Task 5: Baseline Generation Evaluation (Milestone E) ]
```
