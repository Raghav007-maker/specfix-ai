# 08 — Security & Reliability

## 1. Security Architecture & Threat Model

SpecFix operates in a multi-tenant environment processing confidential product specifications and business requirements. Its security model centers on four core defenses:

```
[ Browser / API Client ]
         │ (1. Supabase Auth JWT)
         ▼
[ apps/web Next.js Runtime ]
         │ (2. 'server-only' Repository Boundary - tenantId parameter #1)
         ▼
[ packages/db Repositories ]
         │ (3. Parameterized SQL - Zero String Concatenation)
         ▼
[ PostgreSQL Database ]
         │ (4. Row-Level Security Policies via specfix_member_of)
         ▼
[ Tenant Data Isolated ]
```

---

## 2. Multi-Tenant Isolation Audit

### Dual-Layer Defense
1. **Layer 1: Repository Scope Enforcement (Primary Isolation):**
   * The backend worker and Next.js server actions connect to PostgreSQL via `DATABASE_URL` using the database superuser/postgres role, which bypasses RLS by default.
   * Therefore, **tenant isolation is enforced at the repository layer**. Every function in `packages/db/src/repositories/` requires `tenantId: TenantId` as parameter #1 and includes `where tenant_id = $1` in all queries.
2. **Layer 2: Row-Level Security (Defense-in-Depth):**
   * RLS is enabled on all application tables with policies utilizing `specfix_member_of(tenant_id)`.
   * Directly protects user-JWT sessions and prevents cross-tenant leaks if an API route executes client-side Supabase queries.

### Cross-Tenant Verification
* `packages/db/test/tenant-isolation.test.ts` creates two distinct tenants (`Tenant A` and `Tenant B`), inserts projects, tickets, flags, and sessions under Tenant A, and asserts that queries with Tenant B's credentials return zero rows.

---

## 3. Injection Defense: SQL & Prompt Injection

### SQL Injection Defense
* **Audit Finding:** Zero instances of dynamic SQL query construction using unsanitized string interpolation were found.
* All queries in `packages/db/src/repositories/` utilize node-postgres parameterized statements (`$1, $2, ...`).
* Vector literals in `packages/db/src/repositories/embeddings.ts` format numbers strictly (`[${embedding.join(',')}]`) and pass them as parameterized strings.

### Prompt Injection Defense
* **Threat:** Malicious ticket text designed to override LLM system prompts or exfiltrate private context.
* **Defense Strategy:**
  1. Ticket text is wrapped in unambiguous XML delimiters: `<untrusted_ticket_text>` or `<acceptance_criteria>`.
  2. Any internal occurrence of closing tags in the ticket text is neutralized before prompt formatting (`packages/compiler/src/scenario.ts` and `packages/core/src/analyze.ts`).
  3. Output schemas enforce strict structural adherence via OpenAI's `json_schema` response format.
  4. Span verification: Quotes and citations (`quoted_span`, `covers_ac`) are verified against source criteria before persistence.

---

## 4. Reliability, Transactions, & Concurrency

### Transaction Boundaries
* Multi-row operations use `tx(client => ...)` in `packages/db/src/client.ts`.
* `ingestTicket`: Executes within a single transaction. Locks ticket row, checks content hash, inserts `ticket_versions`, stales superseded flags/scenarios, and emits `readiness_events`.
* `decideScenario` / `decideFlag`: Uses `select ... for update` to prevent race conditions during concurrent reviewer edits.

### Connection Pool & Cold Starts
* Supabase poolers terminate idle connections after periods of inactivity.
* Uncommitted fix in `packages/db/src/client.ts`:
  ```typescript
  connectionTimeoutMillis: Number(process.env.PG_TIMEOUT_MS ?? 30_000)
  ```
  Increases timeout from 10s to 30s to allow sufficient time for cold pooler connections.

### Token Cap Protection
* `isOverTokenCap(tenantId)` in `packages/db/src/repositories/analysis.ts` checks monthly token consumption against `MONTHLY_TOKEN_CAP` (default 5,000,000 tokens) before initiating LLM operations, preventing runaway costs.
