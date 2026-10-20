# 02 — Architecture

## 1. System Architecture Diagram

The SpecFix application follows a layered monorepo architecture:

```mermaid
graph TD
    subgraph Ingestion Layer
        RAW[Raw Ticket: MD / CSV / Jira] --> INGEST[packages/ingest]
        INGEST --> DB_INGEST[ingestTicket in packages/db]
    end

    subgraph Persistence Layer
        DB_INGEST --> DB[(PostgreSQL + pgvector)]
        DB_REPO[packages/db Repositories] --> DB
    end

    subgraph Core AI Pipeline
        DB --> ANALYZE[packages/core: analyzeTicket]
        ANALYZE --> EXTRACT[LLM Extractor Pass]
        EXTRACT --> CRITIC[LLM Adversarial Critic Pass]
        CRITIC --> DB_REPO
    end

    subgraph Web Presentation Layer
        DB_REPO --> WEB[apps/web: Next.js 15 App Router]
        WEB --> REVIEW_UI[Flag Review Tab]
        WEB --> SPECS_UI[Specs & Scenarios Tab]
    end

    subgraph Spec Compilation & Codegen
        SPECS_UI --> COMPILER[packages/compiler: compileScenarios]
        COMPILER --> LLM_COMPILER[LLM Gherkin Pass]
        LLM_COMPILER --> DB_REPO
        SPECS_UI --> SCAFFOLD[packages/compiler: emitPlaywrightScaffold]
        SCAFFOLD --> DB_REPO
    end

    subgraph Embeddings & Traceability
        DB_REPO --> EMBED[packages/core: embedTexts]
        EMBED --> AZURE_EMBED[Azure OpenAI Embeddings]
        AZURE_EMBED --> DB
    end
```

---

## 2. Package Responsibilities & Boundaries

### 1. `apps/web` (Web Application)
* **Role:** Presentation and user workflow coordination.
* **Responsibilities:**
  * Displays ticket queues, ambiguity flags, readiness timelines, and scenario reviews.
  * Server actions handle user decisions and invoke compiler codegen.
  * Reaches database strictly via `apps/web/lib/repos.ts` (which re-exports `@specfix/db` behind `'server-only'`).
* **Constraints:** Must not execute direct SQL queries; all operations are scoped by `tenantId`.

### 2. `packages/core` (AI & Transport Engine)
* **Role:** Provider abstractions, model execution, cost accounting, and embeddings.
* **Responsibilities:**
  * Provider factory (`getClient()`) supporting standard OpenAI and Azure OpenAI.
  * Defensive prompt formatting and structured output parsing (`callStructured`).
  * Token cost estimation and pricing dictionary (`costUsd()`).
  * Batch embedding transport (`embedTexts()`, `embedTextsTolerant()`).
* **Constraints:** Completely stateless with respect to the database. Does not import `@specfix/db`.

### 3. `packages/compiler` (Spec Compiler & Test Emitter)
* **Role:** Generates Gherkin scenarios and emits Playwright test skeletons.
* **Responsibilities:**
  * `compileScenarios()`: Calls LLM with approved requirements and clarifications, parses with `GherkinCompileResultSchema`, and validates `covers_ac` spans.
  * `emitPlaywrightScaffold()`: Deterministic codegen transforming parsed Gherkin steps into TypeScript Playwright test files with `PLACEHOLDER_*` locators.
* **Constraints:** No database dependencies. Returns in-memory domain models.

### 4. `packages/db` (Data Persistence & Tenancy)
* **Role:** Relational persistence, pgvector operations, and schema migrations.
* **Responsibilities:**
  * Connection pooling with SSL handling (`client.ts`).
  * Schema migrations runner (`migrate.ts`).
  * Repositories enforcing tenant isolation (`tenants`, `tickets`, `flags`, `scenarios`, `scaffolds`, `traceability`, `embeddings`).
* **Constraints:** Every repository function takes `tenantId: TenantId` as its first parameter.

### 5. `packages/shared` (Domain Models & Schemas)
* **Role:** Cross-package contracts and validation schemas.
* **Responsibilities:**
  * Zod schemas for analysis results, flags, scenarios, and scaffolds.
  * Gherkin string parsing utility (`parseGherkin()`).
  * Delimiter neutralization helpers.

### 6. `packages/ingest` (Ticket Ingestion)
* **Role:** Raw file parsing and ticket normalization.
* **Responsibilities:**
  * Parses Markdown and CSV formats into `NormalizedTicket`.
  * Sanitizes ticket text to prevent prompt injection.

### 7. `packages/eval` (Evaluation Harness)
* **Role:** Measurement of extraction precision/recall and generation quality.
* **Responsibilities:**
  * Offline scoring against gold-set fixtures.
  * Random-pruning control comparisons.
  * Scenario acceptance and edit-distance metrics.

---

## 3. End-to-End User Workflow Sequence

```mermaid
sequenceDiagram
    autonumber
    actor PM as Product Manager
    participant Web as apps/web (Next.js)
    participant DB as packages/db
    participant Core as packages/core
    participant Compiler as packages/compiler
    participant LLM as OpenAI / Azure OpenAI

    Note over PM,LLM: Step 1: Ingestion & Analysis
    PM->>Web: Navigate to Ticket (e.g. CART-08)
    Web->>DB: Fetch ticket & latest version
    opt Not yet analyzed
        Web->>Core: analyzeTicket(ticket)
        Core->>LLM: Extraction pass (single-shot-v1)
        LLM-->>Core: Candidate flags
        Core->>LLM: Deliberation pass (critic-v1)
        LLM-->>Core: Pruning verdicts
        Core->>DB: recordAnalysis(surviving flags)
    end

    Note over PM,LLM: Step 2: Human Flag Review Gate
    Web->>PM: Display ticket text & ambiguity flags
    PM->>Web: Accept / Edit / Dismiss flag
    Web->>DB: decideFlag(flagId, decision, answer)
    DB-->>Web: All flags resolved
    PM->>Web: Click "Mark Ready for Development"
    Web->>DB: markReady() -> readiness_events

    Note over PM,LLM: Step 3: Spec Compilation Gate
    PM->>Web: Open "Specs" Tab & Click "Generate Scenarios"
    Web->>DB: Verify version is marked ready & under token cap
    Web->>Compiler: compileScenarios(approvedAC, resolvedFlags)
    Compiler->>LLM: Compile Gherkin (compile-gherkin-v1)
    LLM-->>Compiler: Structured Gherkin JSON
    Compiler->>Compiler: Span verification (covers_ac)
    Compiler-->>Web: Verified Scenarios
    Web->>DB: recordCompilation(scenarios)

    Note over PM,LLM: Step 4: Scenario Review & Scaffold Emission
    PM->>Web: Review Scenario -> Click "Accept"
    Web->>DB: decideScenario(scenarioId, 'approved')
    PM->>Web: Click "Emit Playwright scaffold"
    Web->>Compiler: emitPlaywrightScaffold(scenario)
    Compiler-->>Web: Deterministic code (.spec.ts with PLACEHOLDER_*)
    Web->>DB: saveScaffold(code, placeholders)
    PM->>Web: Fill in real locators / Download .spec.ts
    Web->>PM: Stream spec file download
```
