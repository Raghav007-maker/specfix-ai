# 14 — Source of Truth & Open Questions

## 1. Documentation vs. Code Conflicts

### Conflict 1: README Scope vs. Phase 2 Plan
* **README Text:** Section 4 of `README.md` states: *"Explicitly out of scope: Gherkin/Playwright generation, PR-vs-spec verification, doc auto-sync, multi-agent workflows."*
* **Actual Codebase:** Gherkin generation and Playwright scaffold emission are fully implemented in `packages/compiler` and `apps/web/app/tickets/[ticketId]/specs`.
* **Resolution / Source of Truth:** `specfix-phase2-plan.md` (§0) explicitly notes that the README rule was a **Phase 1 scope guard** that takes effect during Phase 1 only. Phase 2 specifically introduces Gherkin and Playwright scaffolds. The README should be updated when Phase 2 merges.

### Conflict 2: Automated Embedding Sync vs. Manual Backfill
* **Phase 2 Plan:** Section 4 of `specfix-phase2-plan.md` and migration `0003_specs.sql` note that embeddings back the fuzzy coverage and drift queries in Milestone D. Migration `0004_embeddings.sql` states: *"a scenario's gherkin_raw is replaced in place when a reviewer edits it, so the embedding is refreshed as part of that write"*.
* **Actual Codebase:** No embedding generation triggers exist in `ingestTicket` or `decideScenario`. Embeddings can currently only be produced by manually executing the untracked script `packages/db/scripts/embed-backfill.ts`.
* **Resolution:** Lifecycle triggers must be added to `packages/db/src/repositories/tickets.ts` and `scenarios.ts` as planned.

### Conflict 3: Model Configuration Fallbacks
* **Implementation Plan:** Documents OpenAI-only `gpt-4o-mini` as the standard default model.
* **Actual Codebase:** Uncommitted modifications in `packages/core/src/config.ts` and `.env` add Azure OpenAI support and point models to `gpt-5.4-mini` and `text-embedding-3-small`.
* **Resolution:** The codebase is transitioning to Azure OpenAI deployments. `packages/core/src/config.ts` acts as the source of truth, supporting both providers.

---

## 2. Questions for Project Owner

1. **Jira OAuth vs. SpecFix Internal Workflow:**
   * Does Phase 2 require an active Jira Cloud round-trip, or should we continue relying on SpecFix's internal `marked_ready` sign-off as the compiler gate?
2. **Gold Set Labeling Status:**
   * Is the gold set in `fixtures/gold/gold-v1.json` expected to remain unpopulated until an external labeling session is complete, or are there off-repo labels that should be imported?
3. **Azure OpenAI Content Filtering Strategy:**
   * Would you prefer we adjust `fixtures/tickets/adversarial/injection-03-ac-instructions.md` to avoid tripping Azure's automated content safety filter, or catch HTTP 400 content moderation rejections inside `packages/compiler/test/injection.test.ts`?
4. **Embedding Backfill Execution Approval:**
   * Once embedding logging is completed, do you authorize executing `npx tsx packages/db/scripts/embed-backfill.ts` against the live database to populate the 15 tickets and 19 scenarios?
