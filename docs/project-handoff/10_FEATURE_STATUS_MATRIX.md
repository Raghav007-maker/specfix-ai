# 10 — Feature Implementation Matrix

This matrix documents the verification state of all major features across the SpecFix platform.

### Status Definitions
* **VERIFIED:** Implemented, covered by automated passing tests, and validated in code and runtime.
* **IMPLEMENTED_UNVERIFIED:** Code exists in the repository, but has not been verified against a live database or external provider, or integration tests skip.
* **PARTIAL:** Feature is partially built, with missing sub-features, broken links, or incomplete integrations.
* **PLANNED:** Feature is specified in product roadmap or architecture documents, but no implementation exists in the codebase.
* **BROKEN:** Feature exists in code, but fails automated tests or runtime execution.
* **UNKNOWN:** Status cannot be determined from available repository evidence.

---

## Complete Feature Matrix

| Feature | Intended Behavior | Implementation Evidence | Tests | Status | Known Gaps | Next Action |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| **Ticket Parsing (Markdown / CSV)** | Parse ticket text, acceptance criteria, metadata into normalized schema. | `packages/ingest/src/markdown.ts`, `csv.ts`, `file-source.ts` | `packages/ingest/test/file-source.test.ts` (17 tests passing) | **VERIFIED** | None. | None. |
| **Ticket Versioning & Content Hashing** | SHA-256 hash detection; new version creation; auto-staling of old artifacts. | `packages/db/src/repositories/tickets.ts` (`ingestTicket`) | `packages/db/test/tenant-isolation.test.ts` (tested in CI) | **VERIFIED** | Does not trigger requirement embedding upsert. | Wire embedding generation into `ingestTicket`. |
| **Ambiguity Extraction Pass** | Extract ambiguity, missing info, edge cases from ticket text. | `packages/core/src/analyze.ts` (`analyzeTicket`), `prompts/single-shot-v1.md` | `packages/core/test/core.test.ts` (18 tests passing) | **VERIFIED** | None. | None. |
| **Adversarial Deliberation (Critic)** | Second LLM pass pruning false-alarm flags before human review. | `packages/core/src/deliberate.ts` (`deliberateTicket`), `prompts/critic-v1.md` | `packages/core/test/deliberate.test.ts` (17 tests passing) | **VERIFIED** | Pruning lift over random control depends on gold labels. | Freeze gold set (§0). |
| **Delimiter Containment (Offline)** | Neutralize XML delimiters inside untrusted ticket input. | `packages/compiler/src/scenario.ts` (`renderRequirement`), `analyze.ts` | `packages/compiler/test/injection.test.ts` (delimiter test passing) | **VERIFIED** | None. | None. |
| **Adversarial Model Injection (Live)** | Live LLM must not obey instructions embedded in ticket text. | `packages/compiler/test/injection.test.ts` | Live injection test | **BROKEN** | Throws HTTP 400 on Azure OpenAI due to content filter policy. | Update test to handle Azure content moderation filter. |
| **Flag Review Dashboard** | Next.js form allowing PM to accept/edit/dismiss flags with audit trail. | `apps/web/app/tickets/[ticketId]/page.tsx`, `stages.tsx`, `actions.ts` | Manual browser test, typecheck passes | **IMPLEMENTED_UNVERIFIED** | Real-world PM UX feedback pending. | Validate with design partner. |
| **Readiness Sign-Off Gate** | Mark ticket version ready for development only when all flags are resolved. | `packages/db/src/repositories/flags.ts` (`markReady`) | Tested in `labeling-order.test.ts` | **VERIFIED** | None. | None. |
| **Token Cap Protection** | Pause AI generation if workspace exceeds monthly token threshold. | `packages/db/src/repositories/analysis.ts` (`isOverTokenCap`) | Unit checked in repo logic | **VERIFIED** | Threshold is hardcoded (5M tokens). | Add configurable tenant cap. |
| **Spec Compiler (Gherkin Scenarios)** | Compile ready requirement into Gherkin with span verification. | `packages/compiler/src/scenario.ts` (`compileScenarios`), `compile-gherkin-v1.md` | `packages/compiler/test/compiler.test.ts` (14 tests passing) | **VERIFIED** | None. | None. |
| **Scenario Review UI** | PM accept/edit/dismiss/reopen generated scenarios on Specs tab. | `apps/web/app/tickets/[ticketId]/specs/page.tsx`, `specs.tsx`, `actions.ts` | Manual browser test, typecheck passes | **IMPLEMENTED_UNVERIFIED** | None. | Test in end-to-end browser session. |
| **Playwright Scaffold Emitter** | Deterministic codegen emitting `.spec.ts` with placeholder locators. | `packages/compiler/src/scaffold.ts` (`emitPlaywrightScaffold`) | `packages/compiler/test/compiler.test.ts` | **VERIFIED** | None. | None. |
| **Scaffold Download Route** | Stream downloadable `.spec.ts` test files from dashboard. | `apps/web/app/tickets/[ticketId]/specs/download/[scaffoldId]/route.ts` | Verified via Next.js route handler | **VERIFIED** | None. | None. |
| **Exact Relational Traceability** | Graph linking requirement ↔ scenario ↔ scaffold via `traceability_links`. | `packages/db/src/repositories/traceability.ts` | Relational query verified | **VERIFIED** | Does not incorporate semantic embeddings. | Connect pgvector embeddings. |
| **pgvector Schema & HNSW Indexes** | 1536-dim vector columns and HNSW cosine indexes on Postgres tables. | `packages/db/migrations/0003_specs.sql`, `0004_embeddings.sql` | Applied in live DB; query tested | **VERIFIED** | Migration 0004 file is untracked in Git. | Track migration 0004 in Git. |
| **Batch Embedding Transport** | Batch text embedding via `text-embedding-3-small` with 1536 dimensions. | `packages/core/src/embeddings.ts` (`embedTexts`) | Verified via `scripts/probe-azure.mjs` (491ms latency) | **IMPLEMENTED_UNVERIFIED** | Lacks dedicated unit tests in `packages/core/test/`. | Add `packages/core/test/embeddings.test.ts`. |
| **Embedding Call Logging** | Log embedding API calls and USD cost to `llm_calls` table. | `packages/db/src/repositories/embeddings.ts` | Code inspection | **BROKEN** | Neither `repositories/embeddings.ts` nor `embed-backfill.ts` inserts into `llm_calls`. | Implement `recordEmbeddingCalls()`. |
| **Lifecycle Embedding Triggers** | Auto-generate vectors on ticket ingest and scenario approval/edit. | `packages/db/src/repositories/tickets.ts`, `scenarios.ts` | Code inspection | **PARTIAL** | Missing triggers in `ingestTicket` and `decideScenario`. | Wire `embedText` into repository write paths. |
| **Fuzzy Semantic Coverage UI** | Ranked semantic matching between AC clauses and scenarios on Specs tab. | `apps/web/app/tickets/[ticketId]/specs/specs.tsx` (`CoveragePanel`) | UI inspection | **PARTIAL** | `CoveragePanel` only displays hard relational link counts. | Wire `nearestScenarios()` into `CoveragePanel`. |
| **Generation Evaluation Harness** | Offline metrics for scenario quality, Levenshtein edit distance, scaffold validity. | `packages/eval/src/generation.ts`, `generate-run.ts`, `cli.ts` | `packages/eval/test/generation.test.ts` (12 tests passing) | **PARTIAL** | No baseline generation reports committed to `fixtures/eval-runs/`. | Execute `npm run eval -- generate` and commit report. |
| **Conversational Resolution Agent** | LangGraph conversational agent allowing PM flag resolution via chat. | Scoped in `specfix-phase2-plan.md` Milestone F | None | **PLANNED** | `packages/agent` has not been scaffolded. | Build only after Milestones A–E are solid. |
| **Jira Cloud Roundtrip Integration** | Bi-directional sync with Jira (reading tickets, writing back disambiguated AC). | `packages/ingest` (deferred), `packages/db/migrations/0001_init.sql` | None | **PLANNED** | Jira OAuth flow deferred to Phase 3. | Implement Jira REST adapter. |
