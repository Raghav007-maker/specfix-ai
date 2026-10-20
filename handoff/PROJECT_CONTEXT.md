# Project Context: SpecFix

## 1. Project Purpose & Intended Users

**SpecFix** is a software requirements analysis and quality platform designed to catch ambiguity, missing information, vague language, contradictions, and untested edge cases in software requirements (Jira tickets, user stories, acceptance criteria) *before* developers write code.

### Intended Users
* **Product Managers (PMs) & Business Analysts:** The primary workflow users. They review AI-detected ambiguity flags, resolve clarifications, and sign off on tickets.
* **Engineering Leads & Developers:** Consumers of disambiguated specifications, generated Gherkin scenarios, and Playwright test skeletons.
* **QA Engineers & SDETs:** Reviewers and adopters of generated test scaffolds and traceability graphs.

### Core Problem & Business Value
In traditional software development, requirements are frequently ambiguous or incomplete. Developers fill gaps with assumptions, creating software that passes unit tests but fails business intent. This causes expensive rework late in QA or production. SpecFix introduces a human-gated AI verification loop that disambiguates specifications at the moment of definition.

---

## 2. Main Features & Expected Behavior

1. **Ticket Ingestion & Versioning:**
   * Ingests tickets from Jira or flat markdown/CSV files.
   * Creates immutable `ticket_versions` keyed by `content_hash`. Re-ingesting unchanged ticket text is a no-op; changing text automatically triggers a new version and marks downstream artifacts as `stale`.
2. **Ambiguity Flagging (Phase 1 Extractor & Adversarial Critic):**
   * **Extractor Pass:** Structured LLM extraction categorizing issues into `missing_info`, `ambiguity`, `edge_case`, `untestable`, or `conflict`.
   * **Adversarial Critic Pass:** A second model pass acting as an adversarial filter to prune false positives before human review.
   * **Human Review Gate:** Form-based dashboard where PMs accept, edit, or dismiss flags.
3. **Readiness Signing & Single Jira Write-Back:**
   * A ticket version is marked "Ready for Dev" only when all flags are resolved.
   * Disambiguated acceptance criteria are written back to Jira exactly once upon human sign-off.
4. **Spec Compiler (Phase 2):**
   * Compiles PM-approved acceptance criteria and resolved clarifications into Gherkin scenarios.
   * Verified verbatim against source text (`covers_ac`).
   * Human gate: reviewers accept, edit, or dismiss each scenario.
5. **Playwright Scaffold Emitter (Phase 2):**
   * Deterministic code generator transforming approved Gherkin scenarios into executable `@playwright/test` skeletons (`.spec.ts`).
   * Generates explicit `PLACEHOLDER_*` selectors for humans to fill in real locators, marked with `test.fixme()`.
6. **Traceability Graph & Embeddings (Phase 2):**
   * Connects requirements (`ticket_versions` + `flags`) ↔ `scenarios` ↔ `test_scaffolds` via `traceability_links`.
   * Stores `vector(1536)` embeddings in pgvector (`requirement_embeddings`, `scenario_embeddings`) to measure semantic coverage and detect specification drift.

---

## 3. Architecture & Major Components

```
                   [ Ticket Source: Markdown / Jira API ]
                                     │
                                     ▼
                      [ packages/ingest: Parsers ]
                                     │
                                     ▼
                     [ packages/db: Ingest & Versions ]
                                     │
                                     ▼
                   [ packages/core: Analysis Pipeline ]
                    ├── Extractor Pass (Structured JSON)
                    └── Adversarial Critic Pass (Pruning)
                                     │
                                     ▼
                [ apps/web: Review Dashboard (PM Gate 1) ]
                 - Accept / Edit / Dismiss Flags
                 - Mark Ready for Development
                                     │
                                     ▼
                  [ packages/compiler: Spec Compiler ]
                    ├── compileScenarios (LLM Gherkin)
                    └── emitPlaywrightScaffold (Deterministic Codegen)
                                     │
                                     ▼
                 [ apps/web: Specs Dashboard (PM Gate 2) ]
                 - Review Scenarios (Accept / Edit / Dismiss)
                 - Emit Playwright Scaffolds
                 - Replace Selectors / Download .spec.ts
                                     │
                                     ▼
                 [ packages/db: Traceability & pgvector ]
                 - Exact Links (traceability_links)
                 - Semantic Vectors (requirement & scenario embeddings)
```

---

## 4. Technology Stack & Workspace Structure

### Workspace Layout
SpecFix is structured as an npm workspaces monorepo:

* **[apps/web](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web):** Next.js 15 (App Router), React 19, Vanilla Tailwind CSS, Radix UI primitives. Implements the Review and Specs dashboards.
* **[packages/compiler](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler):** Gherkin scenario generator ([scenario.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scenario.ts)) and deterministic Playwright emitter ([scaffold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/compiler/src/scaffold.ts)).
* **[packages/core](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core):** OpenAI / Azure OpenAI transport ([openai.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/openai.ts)), analysis engine ([analyze.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/analyze.ts)), adversarial deliberation ([deliberate.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/deliberate.ts)), token cost accounting ([cost.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/cost.ts)), and embeddings transport ([embeddings.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/embeddings.ts)).
* **[packages/db](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db):** PostgreSQL client with connection pooling ([client.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/src/client.ts)), schema migrations, and repositories for tickets, flags, scenarios, scaffolds, traceability, and embeddings.
* **[packages/eval](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval):** Evaluation harness for gold-set validation ([gold.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/gold.ts)), scoring ([score.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/score.ts)), random-pruning control comparisons ([control.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/control.ts)), generation metrics ([generation.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/generation.ts)), and CLI ([cli.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/eval/src/cli.ts)).
* **[packages/ingest](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest):** Markdown and CSV ticket parsers ([markdown.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest/src/markdown.ts), [csv.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest/src/csv.ts)) and filesystem batch ingester ([file-source.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/ingest/src/file-source.ts)).
* **[packages/shared](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/shared):** Zod schemas ([schema.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/shared/src/schema.ts), [scenario.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/shared/src/scenario.ts)), domain types, and Gherkin string parser.

### Key Dependencies
* **Runtime:** Node.js `>=22`, TypeScript `^5.6.3`, `tsx ^4.19.2`
* **Database Driver:** `pg ^8.13.1`, `@types/pg ^8.11.10`
* **Database Engine:** Supabase PostgreSQL with `pgvector` extension
* **Validation:** `zod ^3.23.8`
* **AI Providers:** `openai ^4.71.1` (supports both standard OpenAI and Azure OpenAI endpoints)
* **Testing:** `vitest ^4.1.11`

---

## 5. End-to-End Data Flow

1. **Ingest:** A raw ticket (e.g. `CART-08.md`) is parsed by `packages/ingest`. `ingestTicket` computes a SHA-256 `content_hash`. If the hash is new, a new `ticket_versions` record is inserted.
2. **Analysis:** The user or pipeline runs `analyzeTicket`. The ticket text is wrapped in defensive delimiters (`<untrusted_ticket_text>`), passed to `callStructured` with `single-shot-v1.md`, producing candidate flags.
3. **Deliberation (Critic):** If `--deliberate` is enabled, candidate flags pass to `critic-v1.md`, which returns keep/prune verdicts.
4. **Flag Decision:** Reviewers inspect flags on `apps/web`. When all flags are `accepted`, `edited`, or `dismissed`, the PM signs off, creating a `marked_ready` event in `readiness_events`.
5. **Spec Compilation:** The PM triggers scenario generation. `compileScenarios` combines the approved acceptance criteria and resolved flag answers into a structured prompt (`compile-gherkin-v1.md`). Output scenarios are validated via `GherkinCompileResultSchema` and verbatim span verification (`covers_ac`).
6. **Scaffold Emission:** For accepted scenarios, `emitPlaywrightScaffold` deterministically renders TypeScript Playwright test code containing `PLACEHOLDER_*` locators.
7. **Traceability:** Links connecting requirements, flags, scenarios, and scaffolds are stored in `traceability_links`. Embeddings in `requirement_embeddings` and `scenario_embeddings` enable semantic search and drift detection.

---

## 6. Entity Relationship & Lifecycle Model

```
tenants (id)
  └── projects (id, tenant_id)
        └── tickets (id, tenant_id, project_id, current_version_id)
              ├── ticket_versions (id, tenant_id, ticket_id, content_hash)
              │     ├── flags (id, tenant_id, ticket_version_id, status)
              │     │     └── flag_decisions (id, flag_id, user_id, decision) [Audit Log]
              │     ├── spec_compile_runs (id, tenant_id, ticket_version_id)
              │     ├── scenarios (id, tenant_id, ticket_version_id, compile_run_id, status)
              │     │     ├── scenario_reviews (id, scenario_id, user_id, decision) [Audit Log]
              │     │     ├── test_scaffolds (id, tenant_id, scenario_id, framework, status)
              │     │     └── scenario_embeddings (scenario_id, embedding vector(1536))
              │     ├── requirement_embeddings (ticket_version_id, embedding vector(1536))
              │     ├── readiness_events (id, ticket_id, ticket_version_id, event)
              │     └── traceability_links (id, ticket_version_id, flag_id, scenario_id, scaffold_id)
              └── llm_calls (id, tenant_id, analysis_run_id, compile_run_id, purpose, cost_usd)
```

### Staleness Invariant
Artifacts belong strictly to a `ticket_version_id`. When a ticket is re-ingested with modified text, `ingestTicket` creates a new version and automatically sets `status = 'stale'` on flags, scenarios, and scaffolds linked to preceding versions.

---

## 7. Database Tables & Migrations

### Migrations Sequence
1. **[0001_init.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0001_init.sql):** Core tenancy (`tenants`, `memberships`), projects, tickets, ticket versions, flags, flag decisions, analysis runs, llm calls, and readiness events. Enables RLS.
2. **[0002_deliberation.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0002_deliberation.sql):** Adds `critic` to `llm_calls_purpose_check` and `critic_verdicts` to `flags`.
3. **[0003_specs.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0003_specs.sql):** Installs `pgvector` (`create extension if not exists vector`), creates `spec_compile_runs`, `scenarios`, `scenario_reviews`, `test_scaffolds`, `traceability_links`, `requirement_embeddings`, and `scenario_embeddings`. Adds `compile_gherkin` to `llm_calls.purpose`.
4. **[0004_embeddings.sql](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/db/migrations/0004_embeddings.sql):** Adds `'embed'` to `llm_calls.purpose`. Creates HNSW cosine vector indexes (`requirement_embeddings_hnsw_idx`, `scenario_embeddings_hnsw_idx`) and tenant index on `requirement_embeddings`.

---

## 8. LLM Integration, Azure OpenAI, & Cost Tracking

### Dual Provider Configuration
[packages/core/src/config.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/config.ts) dynamically loads OpenAI or Azure OpenAI:
* If `AZURE_OPENAI_ENDPOINT` is present, [packages/core/src/openai.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/openai.ts) instantiates `AzureOpenAI({ endpoint, apiKey, apiVersion })`.
* Otherwise, it instantiates standard `OpenAI({ apiKey, baseURL })`.

### Supported Models & Cost Accounting
[packages/core/src/cost.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/packages/core/src/cost.ts) tracks token usage per million tokens:
* `gpt-4o-mini`: $0.15 / 1M input, $0.60 / 1M output
* `gpt-5.4-mini` / `5.4-mini`: $0.15 / 1M input, $0.60 / 1M output
* `gpt-4o`: $2.50 / 1M input, $10.00 / 1M output
* `text-embedding-3-small`: $0.02 / 1M input, $0.00 / 1M output

Every model call records token counts and cost in `llm_calls` with explicit purpose attribution (`extract`, `critic`, `judge`, `single_shot`, `compile_gherkin`, `embed`).

---

## 9. Security, Tenancy, & Authentication

* **Tenant Isolation:** Every table carries `tenant_id` foreign-keyed to `tenants(id)` with cascade deletion. All repository functions require `tenantId: TenantId` as their first parameter.
* **Row-Level Security (RLS):** Enabled across all application tables with `specfix_member_of(tenant_id)` security functions.
* **Prompt Injection Containment:** External ticket text is treated strictly as data, wrapped in `<untrusted_ticket_text>` or `<acceptance_criteria>`, with internal closing tags escaped.
* **Authentication:** Supabase Auth (JWT in secure cookies). Session cached per request in [session.ts](file:///c:/Users/Udit%20Bhatt/OneDrive/Desktop/miniproject3rd%20year/apps/web/lib/session.ts) using React `cache()`.

---

## 10. Development & Operations Guide

### Environment Variables
Configure `.env` with:
* `AZURE_OPENAI_ENDPOINT` or `OPENAI_BASE_URL`
* `AZURE_OPENAI_API_KEY` or `OPENAI_API_KEY`
* `AZURE_OPENAI_API_VERSION` (default `2024-10-21`)
* `OPENAI_MODEL_EXTRACT`, `OPENAI_MODEL_JUDGE`, `OPENAI_MODEL_COMPILE`
* `OPENAI_MODEL_EMBED` (default `text-embedding-3-small`)
* `DATABASE_URL` (Postgres connection string)
* `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
* `SPECFIX_TENANT_ID`

### CLI Commands
* **Run web application:** `npm run dev`
* **Run unit tests:** `npm test` or `npx vitest run`
* **Typecheck codebase:** `npm run typecheck`
* **Linting & formatting:** `npm run lint` and `npm run format:check`
* **Database migrations:** `npm run db:migrate`
* **Operator tooling:** `npm run ops -- provision`, `npm run ops -- seed`, `npm run ops -- compile`
* **Evaluation harness:** `npm run eval -- validate --set gold-v1`, `npm run eval -- run`, `npm run eval -- generate`
