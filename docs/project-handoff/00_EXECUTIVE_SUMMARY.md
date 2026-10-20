# 00 — Executive Summary

## 1. Project Overview & Vision

**SpecFix** is a software requirements disambiguation and quality assurance platform. Its core mission is to eliminate specification ambiguity, unaddressed edge cases, untestable criteria, and hidden contradictions in user stories and product tickets *before* engineers begin implementation.

In traditional software delivery, requirements ambiguity causes developers to make unchecked assumptions. Bugs resulting from misunderstandings are usually uncovered late in QA or production, where remediation cost is orders of magnitude higher. SpecFix acts as a quality gate right at the requirements definition stage.

```
[Raw Requirement / Jira Ticket]
            │
            ▼
[SpecFix Analysis Engine (Extractor + Adversarial Critic)]
            │
            ▼
[PM Review & Disambiguation Gate (Form-based)]
            │
            ▼
[Approved Requirement Marked Ready]
            │
            ▼
[Spec Compiler: Gherkin Scenarios + Playwright Test Scaffolds]
            │
            ▼
[Traceability Graph + pgvector Embeddings (Fuzzy Coverage & Drift)]
```

---

## 2. High-Level Architecture & Technical Foundation

SpecFix is built as a clean, modular TypeScript monorepo using npm workspaces:

* **Apps:**
  * `apps/web`: Next.js 15 (App Router), React 19, Tailwind CSS, Radix UI. Implements the Ticket Review and Specs (scenarios/scaffolds) dashboards.
* **Core & Domain Packages:**
  * `packages/core`: LLM client factory (OpenAI + Azure OpenAI), analysis engine, adversarial deliberation, token cost accounting, and embedding transport.
  * `packages/compiler`: Spec Compiler (LLM-driven Gherkin generation with span validation) and deterministic Playwright code generator with placeholder selectors.
  * `packages/db`: PostgreSQL data layer using `pg` connection pooling, schema migrations, and repositories enforcing tenant isolation.
  * `packages/shared`: Zod schemas, domain interfaces, and Gherkin parsing.
  * `packages/ingest`: Markdown and CSV ticket parsers with prompt-injection delimiter containment.
  * `packages/eval`: Evaluation harness measuring model precision/recall against gold sets and generation quality metrics.

---

## 3. Current Implementation Status (Phases 1 & 2)

* **Phase 1 (MVP — Ambiguity Detection & Review):** **Complete.**
  * Ticket ingestion, content hashing, and versioning.
  * Extractor pass (`single-shot-v1.md`) and Adversarial Critic pass (`critic-v1.md`).
  * PM flag review dashboard with accept, edit, and dismiss actions.
  * Readiness gating (`marked_ready`) and token spend ceilings.
* **Phase 2 (Specflow, Scenarios, & Traceability):** **Partially Complete.**
  * **Milestone A (Spec Compiler Core):** Complete. Implemented in `packages/compiler` and `scripts/ops.ts`.
  * **Milestone B (Scenario Review UI):** Complete. "Specs" tab live on `apps/web` with review audit trail.
  * **Milestone C (Playwright Scaffold Emitter):** Complete. Deterministic codegen with placeholder locators and `.spec.ts` download route.
  * **Milestone D (Traceability & Embeddings):** Partially Complete. Exact links and pgvector schema/indexes exist. Embedding transport and repository are implemented in untracked files, but embedding spend is not logged to `llm_calls`, lifecycle triggers are missing, and fuzzy coverage is absent from the UI.
  * **Milestone E (Generation Evaluation):** Partially Complete. Generation metrics and CLI runner exist, but baseline evaluation reports are not yet committed.
  * **Milestone F (Conversational Resolution Agent):** Pending (optional LangGraph agent).

---

## 4. Top Confirmed Technical Findings

1. **Unlogged Embedding Spend (P0):**
   * Migration `0004_embeddings.sql` added `'embed'` to `llm_calls_purpose_check`, but neither `packages/db/src/repositories/embeddings.ts` nor `packages/db/scripts/embed-backfill.ts` inserts embedding call records into `llm_calls`.
2. **Untracked Core Phase 2 Files (P0):**
   * Key embedding implementation files (`packages/core/src/embeddings.ts`, `packages/db/src/repositories/embeddings.ts`, `packages/db/scripts/embed-backfill.ts`, and `packages/db/migrations/0004_embeddings.sql`) exist in the working directory but are untracked in Git.
3. **Database Migration Divergence (P1):**
   * Migration `0004_embeddings.sql` is already applied to the remote Supabase database, but the file is untracked in Git. Live tables `requirement_embeddings` and `scenario_embeddings` currently contain 0 rows.
4. **Azure Content Moderation Policy Blocker (P1):**
   * Running `npx vitest run packages/compiler/test/injection.test.ts` against Azure OpenAI fails with HTTP 400 because simulated attack strings in `injection-03-ac-instructions.md` trigger Azure's content moderation policy.
5. **Missing Fuzzy Coverage UI (P2):**
   * While exact relational coverage is visible in `CoveragePanel`, the pgvector-backed semantic fuzzy coverage ranking and specification drift indicators have not been wired into the frontend.

---

## 5. Immediate Next Steps

1. Implement `recordEmbeddingCalls` in `packages/db/src/repositories/embeddings.ts` and wire it into `packages/db/scripts/embed-backfill.ts`.
2. Add offline unit tests in `packages/core/test/embeddings.test.ts`.
3. Handle Azure OpenAI content filter exceptions in adversarial live tests.
4. Connect automatic requirement and scenario embedding generation to ticket ingestion and scenario review.
5. Implement the semantic fuzzy coverage view on the Specs tab.
