# 06 — AI, Embeddings & LLM Logging

## 1. AI Integration Architecture

SpecFix interacts with OpenAI and Azure OpenAI for three distinct capabilities:
1. **Ambiguity Extraction & Deliberation (Phase 1):** Structured flag extraction followed by adversarial false-positive pruning.
2. **Spec Compilation (Phase 2):** Translation of approved requirements and clarifications into structured Gherkin scenarios.
3. **Embeddings & Vector Search (Phase 2):** Semantic representation of requirements and scenarios for fuzzy coverage and specification drift detection.

---

## 2. Model Configuration & Provider Factory

The client factory lives in `packages/core/src/openai.ts` (`getClient()`) and is configured by `packages/core/src/config.ts`:

```typescript
// Provider resolution
if (config.azureEndpoint) {
  client = new AzureOpenAI({
    endpoint: config.azureEndpoint,
    apiKey: config.openaiApiKey,
    apiVersion: config.azureApiVersion ?? '2024-10-21',
    timeout: config.requestTimeoutMs,
    maxRetries: 0, // Retries handled in application code
  });
} else {
  client = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
  });
}
```

### Models & Deployments
* **Extractor (`OPENAI_MODEL_EXTRACT`):** `gpt-5.4-mini` (or `gpt-4o-mini`).
* **Critic / Judge (`OPENAI_MODEL_JUDGE`):** Shared default with extractor to isolate prompt-induced variance.
* **Compiler (`OPENAI_MODEL_COMPILE`):** `gpt-5.4-mini` (or `gpt-4o-mini`).
* **Embeddings (`OPENAI_MODEL_EMBED`):** `text-embedding-3-small` (producing 1536 dimensions).

---

## 3. End-to-End LLM Workflows

### 1. Ambiguity Extraction (`packages/core/src/analyze.ts`)
* **Input:** `AnalyzableTicket` (external key, title, description, acceptance criteria).
* **Preprocessing:** Strips control characters; bounds text to `MAX_TICKET_INPUT_TOKENS` (default 8,000 tokens); encloses in `<untrusted_ticket_text>` with internal tags escaped.
* **Prompt:** `packages/core/prompts/single-shot-v1.md`.
* **Execution:** Invoked via `callStructured` with strict JSON schema `AnalysisResultSchema`.
* **Output Validation:** Validated via Zod (`AnalysisResultSchema`). Span verification checks that `quoted_span` occurs verbatim in the source text.
* **Logging:** Written to `llm_calls` with `purpose = 'extract'` (or `'single_shot'`).

### 2. Adversarial Critic Pass (`packages/core/src/deliberate.ts`)
* **Input:** Raw ticket text + candidate flags from extractor pass.
* **Prompt:** `packages/core/prompts/critic-v1.md`.
* **Execution:** Evaluates each candidate flag and outputs keep/prune decisions with rationale. Pruned flags are recorded in DB with `critic_verdict = 'pruned'` but suppressed from the human review UI.
* **Logging:** Written to `llm_calls` with `purpose = 'critic'`.

### 3. Spec Compilation (`packages/compiler/src/scenario.ts`)
* **Input:** Approved acceptance criteria + resolved flag answers.
* **Prompt:** `packages/compiler/prompts/compile-gherkin-v1.md`.
* **Execution:** Produces JSON matching `GherkinCompileResultSchema`.
* **Span Verification:** Each scenario's `covers_ac` must occur verbatim in the acceptance criteria. If not found, `covers_ac` is cleared to prevent hallucinated citations.
* **Logging:** Written to `llm_calls` with `purpose = 'compile_gherkin'`.

---

## 4. Deep Investigation: Embeddings & Vector Search

### Technical Specifications
* **Transport Module:** `packages/core/src/embeddings.ts`
* **Persistence Module:** `packages/db/src/repositories/embeddings.ts`
* **Model:** `text-embedding-3-small`
* **Dimensions:** `EMBEDDING_DIMENSIONS = 1536`
* **Batch Size Limit:** `EMBEDDING_BATCH_SIZE = 96` (keeps payloads safely within token ceilings)
* **Storage Schema:**
  * `requirement_embeddings(ticket_version_id PK, tenant_id, content, embedding vector(1536))`
  * `scenario_embeddings(scenario_id PK, tenant_id, content, embedding vector(1536))`
* **Index Configuration:** HNSW with cosine operator (`using hnsw (embedding vector_cosine_ops)`).

### Empty String & Index Alignment
OpenAI rejects empty strings. In `embedTexts()`:
* Empty/whitespace inputs are filtered before API dispatch.
* The return array reserves empty vector slots `[]` for skipped inputs, guaranteeing that output array indices strictly match caller input rows.

### Backfill Script Audit (`packages/db/scripts/embed-backfill.ts`)
1. **Selection Criteria:**
   * Versions missing embeddings: Queries `ticket_versions` on live tickets with no matching row in `requirement_embeddings`.
   * Scenarios missing embeddings: Queries `scenarios` where `status in ('approved', 'edited')` with no matching row in `scenario_embeddings`.
   * Stale versions (`--stale`): Queries rows where `requirement_embeddings.content` does not match the version's current concatenated AC + description.
2. **Safety & Idempotency:**
   * Supports `--dry-run` to calculate character counts and estimated tokens before spending.
   * Upserts on conflict (`on conflict (ticket_version_id) do update`), so interrupted runs can be restarted safely without duplication.
3. **Critical Defect Identified:**
   * `embed-backfill.ts` calculates `totalCostUsd` and receives `outcome.calls`, but **never inserts these records into `llm_calls`**. Embedding spend remains unlogged in the database.

---

## 5. LLM Call Logging Audit (`llm_calls`)

### Schema Structure
```sql
create table llm_calls (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  analysis_run_id   uuid references analysis_runs(id) on delete cascade,
  compile_run_id    uuid references spec_compile_runs(id) on delete cascade,
  purpose           text not null check (purpose in ('extract', 'critic', 'judge', 'single_shot', 'compile_gherkin', 'embed')),
  prompt_version    text not null,
  model             text not null,
  request           jsonb not null,
  response          jsonb,
  latency_ms        integer,
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  cost_usd          numeric(12, 6) not null default 0,
  error             text,
  created_at        timestamptz not null default now()
);
```

### Logging Coverage Status
* **Extractor & Critic:** **Logged.** Handled in `packages/db/src/repositories/analysis.ts` (`recordAnalysis`).
* **Spec Compiler:** **Logged.** Handled in `packages/db/src/repositories/scenarios.ts` (`recordCompilation`).
* **Embeddings:** **NOT LOGGED.** Neither `repositories/embeddings.ts` nor `embed-backfill.ts` writes embedding calls to `llm_calls`.
