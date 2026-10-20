# 05 — APIs & Integrations

## 1. Web Application Routes & Server Actions

The web application (`apps/web`) uses Next.js 15 Server Components and Server Actions rather than traditional REST controllers.

### Route Inventory

| Route | Method / Type | Handler Location | Auth & Tenancy | Purpose |
| :--- | :---: | :--- | :--- | :--- |
| `/` | `GET` (Page) | `apps/web/app/page.tsx` | Authenticated via `requireUser()`, tenant resolved via `requireTenant()` | Displays project selector and active ticket queue. |
| `/tickets/[ticketId]` | `GET` (Page) | `apps/web/app/tickets/[ticketId]/page.tsx` | Authenticated; tenant-scoped | Ticket Review dashboard (ticket text, revealed flags, readiness timeline). |
| `/tickets/[ticketId]/specs` | `GET` (Page) | `apps/web/app/tickets/[ticketId]/specs/page.tsx` | Authenticated; tenant-scoped | Specs dashboard (Gherkin scenarios, Playwright scaffolds, coverage panel). |
| `/tickets/[ticketId]/specs/download/[scaffoldId]` | `GET` (Route Handler) | `apps/web/app/tickets/[ticketId]/specs/download/[scaffoldId]/route.ts` | Authenticated; tenant-scoped | Streams downloaded `.spec.ts` test file with `content-disposition: attachment`. |
| `/login` | `GET` (Page) | `apps/web/app/(auth)/login/page.tsx` | Public | User email/password sign-in. |
| `/onboarding` | `GET` (Page) | `apps/web/app/onboarding/page.tsx` | Authenticated without tenant | Workspace creation flow. |

### Server Actions Inventory

| Server Action | Source File | Input Parameters | DB Repository Functions Called | Downstream LLM Invocation |
| :--- | :--- | :--- | :--- | :--- |
| `decideFlagAction` | `apps/web/app/tickets/[ticketId]/actions.ts` | `ticketId`, `flagId`, `decision`, `editedText`, `answer` | `decideFlag()` in `repositories/flags.ts` | None |
| `markReadyAction` | `apps/web/app/tickets/[ticketId]/actions.ts` | `ticketId` | `markReady()` in `repositories/flags.ts` | None |
| `generateScenarios` | `apps/web/app/tickets/[ticketId]/specs/actions.ts` | `ticketId` | `resolvedFlagsForVersion()`, `recordCompilation()` | Invokes `compileScenarios()` via `packages/compiler` |
| `decideScenarioAction` | `apps/web/app/tickets/[ticketId]/specs/actions.ts` | `ticketId`, `scenarioId`, `decision`, `editedText`, `resolutionNote` | `decideScenario()` in `repositories/scenarios.ts` | None |
| `emitScaffoldAction` | `apps/web/app/tickets/[ticketId]/specs/actions.ts` | `ticketId`, `scenarioId` | `getScenario()`, `saveScaffold()` | Pure deterministic codegen (`emitPlaywrightScaffold`) |
| `decideScaffoldAction` | `apps/web/app/tickets/[ticketId]/specs/actions.ts` | `ticketId`, `scaffoldId`, `status`, `code` | `decideScaffold()` in `repositories/scaffolds.ts` | None |

---

## 2. Package APIs & Inter-Package Contracts

### 1. `@specfix/compiler`
* **Exports:**
  * `compileScenarios(requirement, options)`: Compiles Gherkin from acceptance criteria and resolved flags. Returns `CompileScenariosOutcome`.
  * `emitPlaywrightScaffold(input)`: Generates deterministic Playwright skeleton. Returns `EmittedScaffold`.
  * `renderRequirement(requirement, maxTokens)`: Builds delimited prompt string.

### 2. `@specfix/core`
* **Exports:**
  * `analyzeTicket(ticket, options)`: Runs Extractor pass (`single-shot-v1.md`).
  * `deliberateTicket(ticket, options)`: Runs Extractor + Adversarial Critic passes.
  * `embedTexts(texts, options)`: Batched embedding generator.
  * `embedTextsTolerant(texts, options)`: Fault-tolerant embedding generator for bulk sweeps.
  * `costUsd(model, inputTokens, outputTokens)`: Token cost calculator.
  * `cosineSimilarity(a, b)`: In-memory vector similarity.

### 3. `@specfix/db`
* **Exports:**
  * All functions across `tenants`, `tickets`, `flags`, `scenarios`, `scaffolds`, `traceability`, and `embeddings` repositories.
  * Re-exported directly by `apps/web/lib/repos.ts` behind `'server-only'`.

---

## 4. External Integrations

1. **Azure OpenAI:**
   * Used for structured text completion (`gpt-5.4-mini`) and vector embeddings (`text-embedding-3-small`).
   * Configured via `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_API_VERSION`.
2. **OpenAI (Standard):**
   * Supported as fallback when `OPENAI_API_KEY` and `OPENAI_BASE_URL` are provided.
3. **Supabase (PostgreSQL + Auth):**
   * Relational database with pgvector.
   * Client authenticates with `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` for backend queries and `SUPABASE_ANON_KEY` for browser auth cookies.
4. **Jira Cloud (Deferred):**
   * Configured via `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, and `JIRA_REDIRECT_URI`. Full OAuth roundtrip is planned for Phase 3.

---

## 5. Developer CLI Scripts

* **`scripts/ops.ts` (`npm run ops`):**
  * `ops provision --email <email>`: Provisions Supabase user account.
  * `ops seed --owner <email> --tenant <name> [--analyze]`: Seeds tickets and runs analysis.
  * `ops compile --ticket <path> [--flag "Q => A"] [--persist]`: Tests scenario compilation from CLI.
  * `ops metrics --tenant <uuid>`: Computes precision, recall, and time-to-ready from database.
* **`packages/eval/src/cli.ts` (`npm run eval`):**
  * `eval validate --set <name>`: Validates gold-set syntax offline.
  * `eval run --set <name> --prompt <name> [--deliberate]`: Runs evaluation against gold set.
  * `eval generate --set <name> --prompt <name>`: Runs scenario generation evaluation.
* **`packages/db/scripts/embed-backfill.ts`:**
  * `npx tsx packages/db/scripts/embed-backfill.ts --tenant <uuid> [--dry-run] [--stale]`: Backfills embeddings on existing tickets and scenarios.
