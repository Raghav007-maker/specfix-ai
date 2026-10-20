# 03 — Codebase Map

## 1. Directory Tree Overview

```
.
├── apps/
│   └── web/                                    # Next.js 15 Web Application
│       ├── app/
│       │   ├── (auth)/                         # Login and authentication actions
│       │   ├── onboarding/                     # Organization & workspace setup
│       │   ├── tickets/
│       │   │   └── [ticketId]/
│       │   │       ├── actions.ts              # Flag decision server actions
│       │   │       ├── page.tsx                # Ticket Review dashboard
│       │   │       ├── stages.tsx              # Ticket detail view & flag cards
│       │   │       └── specs/
│       │   │           ├── actions.ts          # Scenario & scaffold server actions
│       │   │           ├── page.tsx            # Specs tab dashboard
│       │   │           ├── specs.tsx           # Scenario & scaffold UI components
│       │   │           └── download/[scaffoldId]/route.ts # .spec.ts file download
│       │   ├── layout.tsx                      # Root layout with user header
│       │   └── page.tsx                        # Ticket queue page
│       ├── components/                         # UI components (Header, Tabs, Badges)
│       ├── lib/
│       │   ├── repos.ts                        # 'server-only' door re-exporting @specfix/db
│       │   ├── session.ts                      # Supabase session cache helper
│       │   ├── tenant.ts                       # Tenant resolution from user cookie
│       │   └── supabase/                       # Server & client Supabase factories
│       ├── middleware.ts                       # Next.js session refresh middleware
│       └── tailwind.config.ts                  # Tailwind styling configuration
├── packages/
│   ├── compiler/                               # Gherkin compiler & Playwright emitter
│   │   ├── prompts/compile-gherkin-v1.md       # Scenario generation prompt template
│   │   ├── src/
│   │   │   ├── index.ts                        # Compiler package exports
│   │   │   ├── scaffold.ts                     # emitPlaywrightScaffold() codegen
│   │   │   ├── scenario.ts                     # compileScenarios() orchestration
│   │   │   └── schema.ts                       # Gherkin Zod compile schemas
│   │   └── test/                               # Compiler unit & adversarial tests
│   ├── core/                                   # AI transport, analysis & embeddings
│   │   ├── prompts/                            # Extractor & Critic prompt files
│   │   ├── src/
│   │   │   ├── analyze.ts                      # analyzeTicket() extractor logic
│   │   │   ├── config.ts                       # Environment config & Azure fallback
│   │   │   ├── cost.ts                         # Token cost accounting & pricing
│   │   │   ├── deliberate.ts                   # deliberateTicket() critic logic
│   │   │   ├── embeddings.ts                   # embedTexts() transport & batching
│   │   │   ├── index.ts                        # Core package exports
│   │   │   ├── openai.ts                       # getClient(), callStructured()
│   │   │   ├── prompt.ts                       # Prompt loader & hash utility
│   │   │   └── schema.ts                       # Structured output formatting
│   │   └── test/                               # Core analysis and cost unit tests
│   ├── db/                                     # Database client, migrations & repos
│   │   ├── migrations/                         # SQL migrations (0001–0004)
│   │   ├── scripts/
│   │   │   ├── embed-backfill.ts               # CLI script for vector backfill
│   │   │   └── migrate.ts                      # Migration runner script
│   │   ├── src/
│   │   │   ├── client.ts                       # pg Pool connection manager
│   │   │   ├── index.ts                        # Database package exports
│   │   │   └── repositories/                   # Domain repositories
│   │   │       ├── analysis.ts                 # recordAnalysis, runs & caps
│   │   │       ├── embeddings.ts               # Vector upserts & similarity search
│   │   │       ├── flags.ts                    # Flag decisions & readiness events
│   │   │       ├── labeling.ts                 # Double-labeling & validation metrics
│   │   │       ├── scaffolds.ts                # Scaffold persistence & decisions
│   │   │       ├── scenarios.ts                # Scenario compilation & reviews
│   │   │       ├── tenants.ts                  # Tenancy & project management
│   │   │       ├── tickets.ts                  # Ingestion & content hashing
│   │   │       └── traceability.ts             # Traceability links & coverage
│   │   └── test/                               # Tenant isolation & labeling tests
│   ├── eval/                                   # Evaluation harness & metrics
│   │   ├── src/
│   │   │   ├── cli.ts                          # `specfix eval` command router
│   │   │   ├── control.ts                      # Random-pruning control arm
│   │   │   ├── generate-run.ts                 # compileScenarios batch evaluation
│   │   │   ├── generation.ts                   # Scenario quality metrics & Levenshtein
│   │   │   ├── gold.ts                         # Gold set loader & validator
│   │   │   ├── metrics.ts                      # Wilson interval rate formatting
│   │   │   ├── report.ts                       # Report builders & diff renderers
│   │   │   ├── runner.ts                       # Extraction prompt evaluation runner
│   │   │   └── score.ts                        # Scorer against gold gap lists
│   │   └── test/                               # Evaluation unit tests
│   ├── ingest/                                 # Ticket parsers
│   │   ├── src/
│   │   │   ├── csv.ts                          # CSV ticket parser
│   │   │   ├── file-source.ts                  # Directory batch file reader
│   │   │   ├── markdown.ts                     # Markdown ticket parser
│   │   │   └── types.ts                        # Ingestion types
│   │   └── test/                               # File ingestion unit tests
│   └── shared/                                 # Shared schemas and domain models
│       └── src/
│           ├── index.ts                        # Shared package exports
│           ├── scenario.ts                     # Gherkin parser & scaffold types
│           └── schema.ts                       # AnalysisResultSchema, FlagSchema
├── fixtures/                                   # Ticket samples, gold sets, adversarial
└── scripts/
    ├── ops.ts                                  # Operator CLI (provision, seed, compile)
    └── probe-azure.mjs                         # Diagnostic Azure OpenAI probe
```

---

## 2. Key Modules & Deep Call Chains

### Chain 1: Spec Compilation Path
1. **Trigger:** User clicks "Generate scenarios" on the Specs tab (`apps/web/app/tickets/[ticketId]/specs/page.tsx`).
2. **Server Action:** Invokes `generateScenarios(formData)` in `apps/web/app/tickets/[ticketId]/specs/actions.ts`.
3. **Guard Validation:**
   * Loads user session and tenant from `apps/web/lib/session.ts` and `tenant.ts`.
   * Checks `listReadinessEvents` in `packages/db/src/repositories/flags.ts` — aborts if ticket is not `marked_ready`.
   * Checks `isOverTokenCap` in `packages/db/src/repositories/analysis.ts` — aborts if monthly limit exceeded.
4. **Compilation Core:** Calls `compileScenarios` in `packages/compiler/src/scenario.ts`.
   * Combines ticket acceptance criteria and resolved flags into XML prompt payload (`renderRequirement`).
   * Calls `callStructured` in `packages/core/src/openai.ts` with `compile-gherkin-v1.md`.
   * Parses output through `GherkinCompileResultSchema` in `packages/compiler/src/schema.ts`.
   * Executes verbatim substring validation on `covers_ac` against source criteria.
5. **Persistence:** Passes resulting scenarios to `recordCompilation` in `packages/db/src/repositories/scenarios.ts`.
   * Opens PostgreSQL transaction via `tx()`.
   * Inserts into `spec_compile_runs`.
   * Inserts each scenario into `scenarios` (skipping duplicates on dedupe key collision).
   * Inserts initial requirement-to-scenario link in `traceability_links`.
   * Inserts compile model call record into `llm_calls` with `purpose = 'compile_gherkin'`.

### Chain 2: Playwright Scaffold Emission Path
1. **Trigger:** User clicks "Emit Playwright scaffold" for an approved scenario.
2. **Server Action:** Invokes `emitScaffoldAction(formData)` in `apps/web/app/tickets/[ticketId]/specs/actions.ts`.
3. **Guard Validation:** Checks `scenario.status` — must be `approved` or `edited`.
4. **Deterministic Codegen:** Calls `emitPlaywrightScaffold` in `packages/compiler/src/scaffold.ts`.
   * Parses scenario Gherkin into `ScenarioStep[]` using `parseGherkin`.
   * Translates `Given` steps into precondition comments.
   * Translates `When`/`Then` steps into `PLACEHOLDER_*` locator statements inside `test.fixme()`.
   * Populates `selectorPlaceholders` array.
5. **Persistence:** Calls `saveScaffold` in `packages/db/src/repositories/scaffolds.ts`.
   * Upserts into `test_scaffolds` on conflict `(tenant_id, scenario_id, framework)`.
   * Inserts `scenario_to_scaffold` link into `traceability_links`.

---

## 3. Code Smells & Architectural Inconsistencies

1. **Dead Embedding Methods:**
   * `nearestRequirements()` and `nearestScenarios()` in `packages/db/src/repositories/embeddings.ts` are exported but never imported anywhere in the monorepo.
2. **Missing Embedding Logging Function:**
   * Unlike `recordAnalysis` and `recordCompilation`, `repositories/embeddings.ts` contains no function to persist `EmbeddingCallRecord` to `llm_calls`.
3. **Adversarial Content Filter Fragility:**
   * `packages/compiler/test/injection.test.ts` does not anticipate provider content filtering, causing live test failure on Azure OpenAI.
