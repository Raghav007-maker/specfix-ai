# Implementation Status Matrix: SpecFix

This document tracks the verified implementation status of all features and milestones across Phase 0, Phase 1, and Phase 2.

*Status Legend:*
* **Complete:** Implemented, verified in codebase, and covered by passing automated tests.
* **Partially Complete:** Implementation exists in the codebase but has missing sub-features, pending integrations, or lacks test coverage.
* **Pending:** Scoped in the roadmap or specifications but not yet implemented.
* **Blocked:** Implementation cannot proceed until a prerequisite or external dependency is resolved.
* **Unverified:** Code exists but could not be validated due to environment or provider constraints.

---

## 1. Summary Matrix

| Milestone / Component | Phase | Status | Primary Files & Repositories |
| :--- | :---: | :---: | :--- |
| **Phase 0: Prompt Validation** | Phase 0 | **Complete** | [packages/core/prompts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/prompts), [fixtures/tickets](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/fixtures/tickets) |
| **Phase 1: Ingestion & Ticket Versioning** | Phase 1 | **Complete** | [packages/ingest](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest), [packages/db/src/repositories/tickets.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/tickets.ts) |
| **Phase 1: Ambiguity Extraction & Deliberation** | Phase 1 | **Complete** | [packages/core/src/analyze.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/analyze.ts), [deliberate.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/deliberate.ts) |
| **Phase 1: Flag Review Dashboard** | Phase 1 | **Complete** | [apps/web/app/tickets/[ticketId]/page.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/page.tsx) |
| **Phase 1: Readiness Gate & Time-to-Ready** | Phase 1 | **Complete** | [packages/db/src/repositories/flags.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/flags.ts) (`markReady`) |
| **Phase 1: Eval Harness & Gold Set** | Phase 1 | **Partially Complete** | [packages/eval](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval), [fixtures/gold/gold-v1.json](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/fixtures/gold/gold-v1.json) |
| **Milestone A: Spec Compiler Core** | Phase 2 | **Complete** | [packages/compiler](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler), [scripts/ops.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/scripts/ops.ts) |
| **Milestone B: Scenario Review UI** | Phase 2 | **Complete** | [apps/web/app/tickets/[ticketId]/specs](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs) |
| **Milestone C: Playwright Scaffold Emitter** | Phase 2 | **Complete** | [packages/compiler/src/scaffold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scaffold.ts) |
| **Milestone D: Traceability Graph & Embeddings** | Phase 2 | **Partially Complete** | [packages/core/src/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts), [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts) |
| **Milestone E: Generation Quality Evaluation** | Phase 2 | **Partially Complete** | [packages/eval/src/generation.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/generation.ts), [generate-run.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/generate-run.ts) |
| **Milestone F: Conversational Resolution Agent** | Phase 2 | **Pending** | `packages/agent` (unstarted) |

---

## 2. Detailed Milestone & Feature Breakdown

### Phase 1 Features

#### 1. Ingestion Pipeline & Ticket Versioning
* **Requirement:** Ingest tickets from Markdown/CSV/Jira. Compute content hash. If hash changes, insert a new `ticket_versions` record and stale earlier flags, scenarios, and scaffolds.
* **Status:** **Complete**
* **Evidence:** [packages/db/src/repositories/tickets.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/tickets.ts) (`ingestTicket`), [packages/ingest/src/file-source.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest/src/file-source.ts).
* **Tests:** [packages/ingest/test/file-source.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest/test/file-source.test.ts) (17 passing tests).
* **Missing / Gaps:** Ingest pipeline does not trigger requirement embedding generation.

#### 2. Ambiguity Detection & Adversarial Critic
* **Requirement:** Extract ambiguity flags using `single-shot-v1.md`. If `--deliberate` is specified, evaluate flags with `critic-v1.md` and prune false alarms.
* **Status:** **Complete**
* **Evidence:** [packages/core/src/analyze.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/analyze.ts) (`analyzeTicket`), [packages/core/src/deliberate.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/deliberate.ts) (`deliberateTicket`).
* **Tests:** [packages/core/test/deliberate.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/test/deliberate.test.ts) (17 passing tests), [packages/core/test/core.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/test/core.test.ts) (18 passing tests).

#### 3. Flag Review Dashboard
* **Requirement:** Form-based dashboard where reviewers accept, edit, or dismiss flags. Decisions recorded in append-only audit table `flag_decisions`.
* **Status:** **Complete**
* **Evidence:** [apps/web/app/tickets/[ticketId]/page.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/page.tsx), [apps/web/app/tickets/[ticketId]/actions.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/actions.ts) (`decideFlagAction`).

#### 4. Gold Set & Eval Harness (§0 Housekeeping)
* **Requirement:** Score models against `fixtures/gold/gold-v1.json` and report precision/recall. Freeze gold set when reported.
* **Status:** **Partially Complete**
* **Evidence:** [packages/eval/src/gold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/gold.ts), [packages/eval/src/runner.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/runner.ts).
* **Missing / Gaps:** [fixtures/gold/gold-v1.json](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/fixtures/gold/gold-v1.json) has empty `gaps: []` and `verdicts: []`, with `"frozen": false`. Only one run report exists (`gold-v1__single-shot-v1.json`); the Critic arm report (`gold-v1__single-shot-v1+deliberated.json`) is not committed.

---

### Phase 2 Milestones (A–F)

#### Milestone A: Spec Compiler Core
* **Requirement:** Migration `0003_specs.sql`, `packages/compiler` package, `compile-gherkin-v1` prompt, Zod validation, span verification (`covers_ac`), and `compile` CLI subcommand in `scripts/ops.ts`.
* **Status:** **Complete**
* **Evidence:**
  * Migration: [packages/db/migrations/0003_specs.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0003_specs.sql) (applied in DB).
  * Compiler: [packages/compiler/src/scenario.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scenario.ts) (`compileScenarios`).
  * Prompt: [packages/compiler/prompts/compile-gherkin-v1.md](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/prompts/compile-gherkin-v1.md).
  * CLI: [scripts/ops.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/scripts/ops.ts#L457) (`compile`).
* **Tests:** [packages/compiler/test/compiler.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/test/compiler.test.ts) (14 passing tests), [packages/compiler/test/injection.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/test/injection.test.ts) (delimiter containment passes; live Azure injection triggers content filter policy).

#### Milestone B: Scenario Review UI
* **Requirement:** "Specs" tab on ticket page in `apps/web`. PM can generate scenarios for an approved version, accept/edit/dismiss each scenario, and maintain an audit trail in `scenario_reviews`.
* **Status:** **Complete**
* **Evidence:**
  * Page: [apps/web/app/tickets/[ticketId]/specs/page.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/page.tsx).
  * Components: [apps/web/app/tickets/[ticketId]/specs/specs.tsx](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/specs.tsx).
  * Server Actions: [apps/web/app/tickets/[ticketId]/specs/actions.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/actions.ts) (`generateScenarios`, `decideScenarioAction`).
  * Repositories: [packages/db/src/repositories/scenarios.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/scenarios.ts) (`decideScenario`, `recordCompilation`).

#### Milestone C: Playwright Scaffold Emitter
* **Requirement:** Deterministic Playwright codegen from accepted Gherkin scenarios. Output uses placeholder locators (`PLACEHOLDER_*`), marked with `test.fixme()`. Downloadable `.spec.ts` and UI checklist for locators.
* **Status:** **Complete**
* **Evidence:**
  * Codegen: [packages/compiler/src/scaffold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scaffold.ts) (`emitPlaywrightScaffold`).
  * Actions & Repos: [apps/web/app/tickets/[ticketId]/specs/actions.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/actions.ts) (`emitScaffoldAction`, `decideScaffoldAction`), [packages/db/src/repositories/scaffolds.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/scaffolds.ts).
  * Download Route: [apps/web/app/tickets/[ticketId]/specs/download/[scaffoldId]/route.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/app/tickets/[ticketId]/specs/download/[scaffoldId]/route.ts).
* **Tests:** Tested in [packages/compiler/test/compiler.test.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/test/compiler.test.ts).

#### Milestone D: Traceability Graph & Embeddings
* **Requirement:** Exact traceability links (`traceability_links`), pgvector embeddings (`requirement_embeddings`, `scenario_embeddings`), HNSW indexes, fuzzy coverage view, and spec drift signal.
* **Status:** **Partially Complete**
* **What Works:**
  * Exact traceability repository and table: [packages/db/src/repositories/traceability.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/traceability.ts).
  * Embedding transport: [packages/core/src/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts).
  * Embedding repository: [packages/db/src/repositories/embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/repositories/embeddings.ts).
  * Migration `0004_embeddings.sql` applied in live database.
* **Missing Functionality:**
  * Embeddings are not generated during ticket ingest or scenario review.
  * Embedding API calls are never logged to `llm_calls` table.
  * Fuzzy coverage view (semantic AC-to-scenario matching) is missing from UI.
  * Live DB has 0 requirement embeddings and 0 scenario embeddings.
  * Files are untracked in Git.

#### Milestone E: Generation Quality Evaluation
* **Requirement:** Offline metrics for generation quality (acceptance rate, clean acceptance rate, Levenshtein edit distance, hallucinated-cover rate, scaffold validity). Automated CLI runner (`npm run eval -- generate`).
* **Status:** **Partially Complete**
* **What Works:**
  * Metrics library: [packages/eval/src/generation.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/generation.ts).
  * Runner: [packages/eval/src/generate-run.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/generate-run.ts).
  * CLI wiring: [packages/eval/src/cli.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/cli.ts#L66).
* **Missing Functionality:**
  * No generation eval run has been executed and committed to [fixtures/eval-runs](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/fixtures/eval-runs).

#### Milestone F: Conversational Resolution Agent
* **Requirement:** Optional LangGraph-based conversational agent allowing PMs to resolve flags via chat, A/B tested against the form dashboard.
* **Status:** **Pending**
* **Notes:** `packages/agent` has not been scaffolded. Marked as optional in `specfix-phase2-plan.md` §5.
