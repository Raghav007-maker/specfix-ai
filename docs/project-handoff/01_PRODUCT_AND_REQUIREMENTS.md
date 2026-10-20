# 01 — Product & Requirements

## 1. Problem Statement & Target Audience

Software user stories and acceptance criteria are frequently incomplete, ambiguous, or untestable. Developers are forced to make unchecked assumptions during coding. The resulting bugs are typically caught in QA cycles, pre-release testing, or customer incidents.

### Target Personas
1. **Product Managers (PMs) & Business Analysts:**
   * Primary operators. They review AI-flagged ambiguities, answer clarifying questions, edit acceptance criteria, and mark tickets ready for development.
2. **Software Engineers & Technical Leads:**
   * Downstream consumers. They receive disambiguated criteria, approved Gherkin scenarios, and starter Playwright test skeletons.
3. **QA Engineers & SDETs:**
   * Verification owners. They take emitted Playwright scaffolds, substitute placeholder locators with actual DOM selectors, and automate regression test suites.

---

## 2. Intended Product vs. Current Product

### Intended Product (Roadmap & Architectural Plans)
As defined in `specfix-implementation-plan.md` and `specfix-phase2-plan.md`:
* Seamless bi-directional Jira integration (reading backlogs, writing back disambiguated criteria once at sign-off).
* Dual-pass ambiguity detection with an Adversarial Critic beating random-pruning controls.
* Automated compilation of approved acceptance criteria into verified Gherkin scenarios.
* Deterministic Playwright scaffold emission with locator checklists.
* Full requirements-to-test traceability graph with pgvector semantic similarity, enabling:
  * Fuzzy coverage ("Which acceptance criteria clauses have no matching scenario?").
  * Specification drift detection ("This ticket text was edited; which approved scenarios are now suspect?").
* Optional conversational agent (LangGraph) as an A/B tested alternative to the form dashboard.

### Current Product (Demonstrable Codebase Today)
* **Ingestion:** Supports local Markdown and CSV ticket ingestion with SHA-256 content hashing. Jira OAuth credentials and API integration are stubbed/deferred.
* **Analysis Engine:** Functional Extractor (`single-shot-v1.md`) and Adversarial Critic (`critic-v1.md`) passes producing structured flags with category, impact, and questions for the PM.
* **Flag Review:** Operational Next.js web application (`apps/web`) where reviewers accept, edit, or dismiss flags with full audit logging (`flag_decisions`).
* **Readiness Gate:** Tickets transition to `marked_ready` only after all flags are resolved.
* **Spec Compiler:** Operational compilation of ready versions into Gherkin scenarios via `compile-gherkin-v1.md` with verbatim `covers_ac` span verification.
* **Scenario & Scaffold UI:** Functional "Specs" tab allowing reviewers to accept/edit/dismiss scenarios, emit Playwright scaffolds, edit placeholder selectors, and download `.spec.ts` test files.
* **Traceability & Embeddings:** Exact relational traceability links are recorded in `traceability_links`. pgvector tables exist, and embedding generation code is written, but embeddings are currently disconnected from the live ingestion and review lifecycle, and the fuzzy coverage view is absent from the UI.

---

## 3. Core Business Entities & Invariants

```
Tenant (Company / Organization)
  └── Project (e.g., Checkout, Authentication)
        └── Ticket (External ID, e.g., CART-08)
              ├── TicketVersion (Immutable snapshot keyed on content_hash)
              │     ├── Flag (Detected ambiguity / missing info)
              │     │     └── FlagDecision (Reviewer verdict: accept/edit/dismiss)
              │     ├── Scenario (Compiled Gherkin scenario)
              │     │     ├── ScenarioReview (Audit history)
              │     │     └── TestScaffold (Emitted Playwright skeleton)
              │     ├── TraceabilityLink (Links requirement ↔ scenario ↔ scaffold)
              │     └── Embeddings (Vector representation of requirement & scenario)
              └── LLMCall (Logged model invocation with token count & USD cost)
```

### Non-Negotiable Business Invariants
1. **Mandatory Human Gate:** No AI-generated artifact (ambiguity flag, Gherkin scenario, or Playwright scaffold) is considered "ready" without human approval.
2. **Ticket Text is Data, Never Instructions:** All external ticket input is enclosed in protective delimiters (`<untrusted_ticket_text>` or `<acceptance_criteria>`). Internal closing delimiters are escaped.
3. **Version-Scoped Artifacts (Staleness Invariant):** Flags, scenarios, and scaffolds attach to a specific `ticket_version_id`. When ticket text changes, a new version is created and previous artifacts automatically become `stale`.
4. **Single Sign-Off Jira Write:** When Jira integration lands, the write-back occurs exactly once upon human sign-off. The system never continuously mutates the Jira ticket during developer coding.
5. **Strict Schema Validation:** Every LLM response is parsed and validated against Zod schemas (`packages/shared`) before touching the database or user interface.
6. **Complete Model Cost Attribution:** Every model call is logged in `llm_calls` with prompt version, input/output tokens, latency, and calculated USD cost.

---

## 4. Open Questions Requiring Human Clarification

1. **Jira Adapter Timeline:**
   * Is Jira synchronization planned for Phase 2 completion or deferred entirely to Phase 3? Current generation hooks off internal SpecFix `marked_ready` events.
2. **Gold Set Finalization (§0 Housekeeping):**
   * When will the reviewer labels and verdicts be loaded into `fixtures/gold/gold-v1.json` to freeze the Phase 1 evaluation baseline?
3. **Embedding Trigger Strategy:**
   * Should requirement embeddings be computed synchronously during ticket ingestion or queued as an asynchronous background worker task?
4. **Adversarial Content Policy on Azure:**
   * Since Azure OpenAI content filters reject the test fixture `injection-03-ac-instructions.md`, should the test suite catch content filter errors as expected safety rejections, or should the fixture be rephrased?
