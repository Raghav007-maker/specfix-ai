# 04 — Database & Migrations

## 1. Migration History & Execution State

Database migrations are located in `packages/db/migrations/` and executed sequentially by `packages/db/scripts/migrate.ts`. Applied migrations are recorded in `schema_migrations(name, applied_at)`.

### Migration Inventory & Application Status

| Migration File | Tracked in Git? | Applied to Live DB? | Applied At (UTC) | Description |
| :--- | :---: | :---: | :---: | :--- |
| `0001_init.sql` | Yes | Yes | `2026-08-31 17:39:03` | Creates core multi-tenant schema, tickets, versions, flags, decisions, analysis runs, llm calls, and RLS policies. |
| `0002_deliberation.sql` | Yes | Yes | `2026-09-30 05:45:57` | Adds `critic` to `llm_calls.purpose` and `critic_verdicts` to `flags`. |
| `0003_specs.sql` | Yes | Yes | `2026-10-15 07:20:33` | Enables `vector` extension. Creates `spec_compile_runs`, `scenarios`, `scenario_reviews`, `test_scaffolds`, `traceability_links`, `requirement_embeddings`, and `scenario_embeddings`. Adds `compile_gherkin` to `llm_calls.purpose`. |
| `0004_embeddings.sql` | **No (Untracked)** | Yes | `2026-10-16 12:00:13` | Adds `'embed'` to `llm_calls.purpose`. Creates HNSW cosine vector indexes and tenant indexes on embedding tables. |

### Migration Git Divergence
* **Critical Finding:** `0004_embeddings.sql` is applied to the production database, but the file is untracked in Git. A fresh clone running `npm run db:migrate` would fail to apply migration 0004 unless the file is tracked.

---

## 2. Table-by-Table Schema Inventory

### 1. `tenants` & `memberships`
* `tenants`: Primary tenant entity (`id uuid PK`, `name text`, `created_at`).
* `memberships`: Associates users with tenants (`id uuid PK`, `tenant_id FK`, `user_id FK references auth.users`, `role text check ('owner'|'reviewer')`, `created_at`).

### 2. `tickets` & `ticket_versions`
* `tickets`: Top-level ticket entity (`id uuid PK`, `tenant_id FK`, `project_id FK`, `external_id text`, `external_key text`, `current_version_id FK`). Unique on `(tenant_id, project_id, external_id)`.
* `ticket_versions`: Immutable requirement snapshot (`id uuid PK`, `tenant_id FK`, `ticket_id FK`, `content_hash text`, `title text`, `description_text text`, `acceptance_criteria_text text`, `captured_at`). Unique on `(tenant_id, ticket_id, content_hash)`.

### 3. `flags` & `flag_decisions`
* `flags`: Ambiguity flags (`id uuid PK`, `tenant_id FK`, `ticket_version_id FK`, `category text`, `status text check ('open'|'accepted'|'edited'|'dismissed'|'stale')`, `origin text`, `question_for_pm text`, `critic_verdict text`).
* `flag_decisions`: Append-only audit trail (`id uuid PK`, `tenant_id FK`, `flag_id FK`, `user_id FK`, `decision text`, `edited_text text`, `answer text`, `created_at`).

### 4. `scenarios` & `scenario_reviews`
* `scenarios`: Compiled Gherkin scenarios (`id uuid PK`, `tenant_id FK`, `ticket_id FK`, `ticket_version_id FK`, `compile_run_id FK`, `title text`, `gherkin_raw text`, `status text check ('draft'|'approved'|'edited'|'dismissed'|'stale')`, `origin text`, `source_flag_ids uuid[]`, `covers_ac text`, `dedupe_key text`). Unique on `(tenant_id, ticket_version_id, dedupe_key)`.
* `scenario_reviews`: Append-only audit trail (`id uuid PK`, `tenant_id FK`, `scenario_id FK`, `user_id FK`, `decision text check ('approved'|'edited'|'dismissed'|'reopened')`, `edited_text text`, `resolution_note text`, `created_at`).

### 5. `test_scaffolds`
* `test_scaffolds`: Emitted Playwright test code (`id uuid PK`, `tenant_id FK`, `scenario_id FK`, `ticket_id FK`, `ticket_version_id FK`, `framework text check ('playwright')`, `code text`, `selector_placeholders jsonb`, `status text check ('draft'|'approved'|'edited'|'dismissed'|'stale')`). Unique on `(tenant_id, scenario_id, framework)`.

### 6. `traceability_links`
* `traceability_links`: Graph edges (`id uuid PK`, `tenant_id FK`, `ticket_version_id FK`, `flag_id FK`, `scenario_id FK`, `scaffold_id FK`, `link_type text check ('requirement_to_scenario'|'scenario_to_scaffold'|'requirement_to_scaffold')`, `created_by text check ('compiler'|'human')`, `user_id FK`, `created_at`). Check constraint ensures at least one endpoint is non-null.

### 7. `requirement_embeddings` & `scenario_embeddings`
* `requirement_embeddings`: `ticket_version_id uuid PK references ticket_versions(id) on delete cascade`, `tenant_id FK`, `content text`, `embedding vector(1536)`, `model text`, `created_at`.
  * Indexes: HNSW cosine index `requirement_embeddings_hnsw_idx`, B-tree index `requirement_embeddings_tenant_idx`.
* `scenario_embeddings`: `scenario_id uuid PK references scenarios(id) on delete cascade`, `tenant_id FK`, `content text`, `embedding vector(1536)`, `model text`, `created_at`.
  * Indexes: HNSW cosine index `scenario_embeddings_hnsw_idx`, B-tree index `scenario_embeddings_tenant_idx`.

### 8. `llm_calls` & `readiness_events`
* `llm_calls`: Audit table for model spend (`id uuid PK`, `tenant_id FK`, `analysis_run_id FK`, `compile_run_id FK`, `purpose text check in ('extract', 'critic', 'judge', 'single_shot', 'compile_gherkin', 'embed')`, `prompt_version text`, `model text`, `request jsonb`, `response jsonb`, `latency_ms integer`, `input_tokens integer`, `output_tokens integer`, `cost_usd numeric(12,6)`, `error text`, `created_at`).
* `readiness_events`: Sign-off timeline (`id uuid PK`, `tenant_id FK`, `ticket_id FK`, `ticket_version_id FK`, `event text check in ('ticket_ingested', 'analysis_complete', 'all_flags_resolved', 'marked_ready')`, `user_id FK`, `backfilled boolean`, `occurred_at`).

---

## 3. Row-Level Security & Isolation Verification

* **Defense in Depth:** RLS is enabled on all tables:
  ```sql
  alter table <table_name> enable row level security;
  create policy <table_name>_tenant_all on <table_name> for all
    using (specfix_member_of(tenant_id))
    with check (specfix_member_of(tenant_id));
  ```
* **Repository Architecture:** RLS protects browser/JWT clients. Background services and workers connecting via `DATABASE_URL` bypass RLS. Therefore, **the repository layer is the true isolation boundary**.
* **Repository Verification:** Every function in `packages/db/src/repositories/` enforces `tenantId` as parameter #1 and includes `where tenant_id = $1` in all SELECT, UPDATE, and DELETE queries.

---

## 4. Live Database Row Counts

Verified via non-destructive read-only queries on the production database:
* `tickets`: 15
* `ticket_versions`: 15
* `flags`: 48
* `flag_decisions`: 32
* `readiness_events`: 18
* `scenarios`: 19
* `scenario_reviews`: 12
* `test_scaffolds`: 0
* `traceability_links`: 24
* `requirement_embeddings`: **0**
* `scenario_embeddings`: **0**
* `llm_calls`: 84
