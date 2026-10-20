# 07 — Testing & Quality

## 1. Test Setup & Tooling

SpecFix uses **Vitest 4.1.11** as its monorepo test runner, configured in `vitest.config.ts`.
* **Language & Transpilation:** TypeScript native execution via Vitest and `tsx`.
* **Linting:** ESLint 9 (`eslint.config.mjs`) using Flat Config.
* **Formatting:** Prettier 3.3 (`.prettierrc.json`).
* **Typechecking:** `tsc --noEmit` across all workspaces.

---

## 2. Test Suite Inventory

| Test Suite / Path | Workspace | Primary Coverage | Execution Mode | Passing Tests |
| :--- | :--- | :--- | :---: | :---: |
| `packages/core/test/core.test.ts` | `@specfix/core` | Prompt loading, hash determinism, cost pricing, token estimation | Offline Unit | 18 |
| `packages/core/test/deliberate.test.ts` | `@specfix/core` | Deliberation response formatting, keep/prune parsing, fallback logic | Offline Unit | 17 |
| `packages/core/test/injection.test.ts` | `@specfix/core` | Delimiter escaping, system prompt protection, flag suppression defense | Live API / Mock | 3 |
| `packages/compiler/test/compiler.test.ts` | `@specfix/compiler` | Playwright scaffold emitter, selector placeholders, Gherkin schemas | Offline Unit | 14 |
| `packages/compiler/test/injection.test.ts` | `@specfix/compiler` | Delimiter containment in AC; live model instruction containment | Offline + Live API | 1 passed, 1 failed |
| `packages/eval/test/control.test.ts` | `@specfix/eval` | Random-pruning control arm, Fisher exact test, seed determinism | Offline Unit | 15 |
| `packages/eval/test/gold.test.ts` | `@specfix/eval` | Gold-set schema validation, inconsistency detection | Offline Unit | 14 |
| `packages/eval/test/scoring.test.ts` | `@specfix/eval` | Gap matching, category scoring, precision/recall metrics | Offline Unit | 31 |
| `packages/eval/test/metrics.test.ts` | `@specfix/eval` | Wilson score interval, rate formatting | Offline Unit | 13 |
| `packages/eval/test/generation.test.ts` | `@specfix/eval` | Levenshtein edit distance, normalized edit distance, acceptance rates | Offline Unit | 12 |
| `packages/eval/test/generate-run.test.ts` | `@specfix/eval` | Generation report builders, diff renderers | Offline Unit | 4 |
| `packages/ingest/test/file-source.test.ts` | `@specfix/ingest` | Markdown parser, frontmatter parsing, CSV parsing, file discovery | Offline Unit | 17 |
| `packages/shared/test/shared.test.ts` | `@specfix/shared` | Zod schema validation, Gherkin step parser | Offline Unit | 16 |
| `packages/db/test/tenant-isolation.test.ts` | `@specfix/db` | Cross-tenant data isolation across repositories | Database Integration | 15 skipped (local) |
| `packages/db/test/labeling-order.test.ts` | `@specfix/db` | Blind-first review ordering, unrevealed flag hiding | Database Integration | 13 skipped (local) |

---

## 3. Database Test Isolation Guardrail (`setup-db.ts`)

In `test/setup-db.ts`:
```typescript
const testUrl = process.env.SPECFIX_TEST_DATABASE_URL;
if (testUrl) {
  process.env.DATABASE_URL = testUrl;
} else {
  delete process.env.DATABASE_URL;
}
```
* **Why Database Tests Skip Locally:** Vitest loads `.env` which points to the live/development database. The database suites write disposable fixtures (tenants, users, flags). To prevent contaminating the real database, `setup-db.ts` automatically deletes `DATABASE_URL` unless `SPECFIX_TEST_DATABASE_URL` is explicitly defined.
* **In CI:** GitHub Actions defines `SPECFIX_TEST_DATABASE_URL` pointing to an ephemeral `pgvector/pgvector:pg16` container, where migrations and isolation tests run fully.

---

## 4. Verified Test Execution Results

During the technical audit, the following non-destructive commands were executed:

### Command: `npm run typecheck`
* **Result:** Exit Code 0 (Clean pass).
* **Scope:** Verified TypeScript across all packages and apps without emitting build output.

### Command: `npx vitest run`
* **Result:** 13 passed, 1 failed, 1 skipped test file (176 passed, 1 failed, 28 skipped).
* **Duration:** 18.45s.
* **Failure Analysis:**
  * **Failing Test:** `packages/compiler/test/injection.test.ts > prompt injection (live model) > compiles scenarios instead of emitting the injected code`.
  * **Failure Reason:** Azure OpenAI threw HTTP 400: `The response was filtered due to the prompt triggering Azure OpenAI's content management policy`. The attack simulation text in `injection-03-ac-instructions.md` triggered Microsoft's content safety filters.

---

## 5. Critical Test Coverage Gaps

1. **Zero Embedding Tests:**
   * No unit tests exist for `packages/core/src/embeddings.ts` (testing `embedTexts`, `cosineSimilarity`, `toVectorLiteral`, or `EmbeddingDimensionError`).
   * No repository tests exist for `packages/db/src/repositories/embeddings.ts`.
2. **Missing Spec Compilation DB Tests:**
   * No integration tests verify `recordCompilation` transaction rollback or scenario deduplication in `packages/db/test/`.
3. **Missing Playwright Codegen Compilation Tests:**
   * No automated test verifies that emitted Playwright scaffold strings parse cleanly through `@playwright/test` compiler.
