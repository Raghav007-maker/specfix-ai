# SpecFix — Phase 2 Implementation Plan (Gherkin/Playwright scaffolds + traceability)

> Companion to `specfix-implementation-plan.md`. That document scopes Phase 0–1 and is the
> source of truth for the flagging wedge. This one scopes Phase 2 and takes effect now that the
> Phase 1 validation gate is reported cleared (see §0). The README's "do not add Gherkin /
> Playwright" rule was a **Phase-1 scope guard**; Phase 2 is exactly where those features are
> meant to land per the roadmap in §3 of the Phase 1 plan. Update the README's scope section when
> Milestone A merges so the two never disagree.

---

## 0. Entry gate — status

The Phase 1 gate for starting Phase 2 (Phase 1 plan §3, §8) is: **flag precision holding up on
real, independently-scored tickets, with the Critic arm beating the volume-matched random-pruning
control (p < 0.05) and zero gaps lost to pruning.** The team reports this validation is done
outside the repo, and we are proceeding on that basis.

One housekeeping item to close in parallel with Milestone A, because Phase 2's traceability work
points back to a baseline that must be on record:

- Load the team's labels into `fixtures/gold/gold-v1.json` (reviewer gap lists + per-flag
  verdicts), set `frozen: true`, and commit the real eval reports for **both** arms
  (`gold-v1__single-shot-v1.json` and `gold-v1__single-shot-v1+deliberated.json`, the latter
  carrying its `control` block). The gold file's own note says to freeze it "the moment a number
  from it is reported anywhere." This is not a gate on Phase 2 — it is making the validation we
  are relying on auditable instead of verbal.

---

## 1. Non-negotiables carried forward from Phase 1

Every one of these already holds in the codebase and must extend to the new artifacts unchanged:

- **A human review gate after every AI-generated artifact.** This now covers generated Gherkin
  scenarios and Playwright scaffolds. Nothing generated is "ready" until a human accepts it, the
  same way no flag resolves without a decision (`packages/db` `decideFlag`).
- **Ticket text — and now acceptance criteria — is data, never instructions.** Scenario
  generation reuses the delimiter-neutralization and span-verification in
  `packages/core/src/analyze.ts`. Generated steps that quote the source are verified against it
  exactly as `quoted_span` is today.
- **No LLM output is used without zod validation** (`packages/shared`). Gherkin and scaffold
  payloads get their own strict schemas before they touch the DB or UI.
- **Tenant isolation is a schema decision, not a retrofit.** Every new table carries `tenant_id`,
  has RLS enabled in migration `0003`, and is reached only through a `packages/db` repository
  whose first argument is `tenantId`. No raw clients in `apps/*`.
- **Artifacts belong to a `ticket_version`, not a ticket.** Reuse the `stale` mechanism: when a
  ticket is re-ingested with new text, its scenarios and scaffolds go stale rather than silently
  attaching to changed requirements.
- **Every model call is logged** (`llm_calls`) with prompt version, input, output, cost — the
  eval substrate. New call purposes are added to the check constraint, not invented ad hoc.
- **Eval-first.** A generation feature ships with the measurement that tells us it helps, and
  where a mechanical trick could fake the number, it ships with the control that exposes that —
  the same discipline as the Critic's random-pruning test.

---

## 2. Scope

**In scope for Phase 2:**

- Gherkin scenario generation from PM-approved, disambiguated acceptance criteria.
- Playwright scaffold generation from approved scenarios, with **placeholder selectors only** —
  a human fills in real ones. Ungated selector generation produces flaky/wrong tests; every
  competitor (Qase, TestCollab) gates it, and so do we.
- A requirement → scenario → test (→ later, code) **traceability graph**, with pgvector
  embeddings for fuzzy coverage and drift detection.
- An **optional** single conversational resolution agent as an *alternative* UI to the
  form-based flag dashboard — A/B tested against the form, not a default replacement, not
  autonomous, same human gate.

**Still out of scope (Phase 3+):** PR-vs-spec verification, hard merge gating, doc-sync
proposals, autonomous or multi-agent workflows. Note the unresolved platform risk: Atlassian's
Rovo Dev already validates code changes against Jira acceptance criteria, so Phase 3's
PR-verification piece needs a specific "why us, not Atlassian" answer **before** it is built.

**Dependency clarification — where generation hooks in.** The Phase 1 architecture diagram shows
Gherkin generation sitting *after* the one Jira write-back. That write-back is deferred
(`markReady` is internal-only today), so Phase 2 keys generation off **SpecFix's own approved
state** — a `ticket_version` whose flags are all resolved and marked ready (`readiness_events`),
with the disambiguated AC captured in SpecFix. This deliberately keeps Phase 2 independent of the
still-unbuilt Jira adapter: generation needs *approved requirements*, not a Jira round-trip.

---

## 3. Architecture additions

```
Approved requirement  (ticket_version: flags resolved, marked ready, disambiguated AC)
        │
        ▼
Spec Compiler  (LLM call — AC → Gherkin scenarios; output zod-validated, steps span-verified)
        │
        ▼  [HUMAN REVIEW GATE: accept / edit / dismiss per scenario, audit-logged]
        │
Approved scenarios
        │
        ▼
Scaffold Emitter  (DETERMINISTIC codegen — Gherkin → Playwright skeleton, placeholder selectors)
        │
        ▼  [HUMAN REVIEW GATE: accept / edit; human fills real selectors]
        │
Traceability store  (Postgres + pgvector: requirement ↔ scenario ↔ scaffold links + embeddings)
        │
        ▼
Coverage / drift views in the dashboard
```

**New / changed workspaces:**

| Package | Change |
|---|---|
| `packages/compiler` (new) | Gherkin generation (LLM, mirrors `packages/core` structure: `prompts/`, zod schema, call logging, output validation) **and** the deterministic Playwright scaffold emitter. Imports `@specfix/shared` and `@specfix/core` helpers; returns data only, no DB. |
| `packages/db` | Migration `0003_specs.sql`: scenarios, scenario_reviews, test_scaffolds, traceability_links, pgvector embeddings. New repositories: `scenarios.ts`, `scaffolds.ts`, `traceability.ts`. Extend `llm_calls.purpose`. |
| `packages/shared` | New schemas: `GherkinScenarioSchema`, `ScaffoldSchema`, status/origin enums reused. |
| `packages/eval` | New arm + metrics for generation quality (§6). Keeps per-arm committed reports. |
| `apps/web` | A **"Specs" tab** on the ticket page: generate → review scenarios → review scaffolds → traceability/coverage view. Pure server actions through repositories, like the existing review flow. |
| `packages/agent` (new, optional, Milestone F) | The single conversational resolution agent (LangGraph). Alternative UI; writes nothing without the existing human gate. |

**New infrastructure:** enable **pgvector** (explicitly out for Phase 1) and embeddings via
`text-embedding-3-small` (`OPENAI_MODEL_EMBED`). pgvector is comfortable below ~1M vectors, which
is well beyond this stage.

---

## 4. Data model — migration `0003_specs.sql` (sketch)

All tables: `tenant_id` (FK, RLS enabled), scoped via repositories.

- **scenarios** — `id, tenant_id, ticket_id, ticket_version_id, analysis_run_id?, gherkin_raw
  text, title, status ('draft'|'approved'|'edited'|'dismissed'|'stale'), origin
  ('ai_agent'|'human'), source_flag_ids uuid[] (which resolved flags drove it), created_at`.
  Versioned to `ticket_version_id` so it goes `stale` on re-ingest, reusing the Phase 1 pattern.
- **scenario_reviews** — append-only audit, mirror of `flag_decisions`
  (`scenario_id, user_id, decision, edited_text, note, created_at`). Never updated/deleted.
- **test_scaffolds** — `id, tenant_id, scenario_id, framework ('playwright'), code text,
  selector_placeholders jsonb, status, created_at`. Deterministically derived from an approved
  scenario; regenerable.
- **traceability_links** — `requirement (ticket_version_id + optional flag_id) ↔ scenario_id ↔
  scaffold_id`, `link_type`, `created_by`, so coverage is a query, not a guess.
- **requirement_embeddings / scenario_embeddings** — pgvector columns for fuzzy coverage
  ("which AC clause has no scenario?") and drift ("this ticket_version changed; which approved
  scenarios are now suspect?").
- **llm_calls.purpose** — extend the check to add `'compile_gherkin'` (and `'agent_turn'` in
  Milestone F) so Phase 2 spend is separable from Phase 1, exactly as `'critic'` was added in
  `0002`.

---

## 5. Build sequence (~8–12 weeks)

**Milestone A — Spec Compiler core (wk 1–2).** Migration `0003` + pgvector; `packages/compiler`
skeleton; `GherkinScenarioSchema`; `compile-gherkin-v1` prompt; call logging + output/span
validation; unit tests + an adversarial case in the injection suite (an AC that tries to inject
instructions into the generated spec). Driven by the `scripts/ops.ts` CLI first (a
`compile` subcommand), no UI yet — the same "prove the core on fixtures before building UI"
order Phase 1 used. Close the §0 gold-set housekeeping here.

**Milestone B — Scenario review UI (wk 3–4).** The Specs tab: generate scenarios for an approved
ticket_version, then accept/edit/dismiss each one with an audit trail, stale-on-new-version.
This is the human gate; nothing proceeds to scaffolds without it.

**Milestone C — Playwright scaffold emitter (wk 5–6).** Deterministic Gherkin → Playwright
skeleton (keep it codegen, not an LLM call, so output is stable and reviewable), placeholder
selectors clearly marked, export/download, review gate. Measure scaffold parse/compile validity.

**Milestone D — Traceability graph (wk 6–8).** Links + embeddings; a coverage view (which
AC/requirements have accepted scenarios and scaffolds, which resolved flags are still untested)
and a drift signal when a ticket_version changes under approved specs.

**Milestone E — Generation eval (wk 8–10).** Arms + metrics (§6) wired into `packages/eval` with
committed per-arm reports, so a prompt change that lowers scenario quality shows up as a diff.

**Milestone F — Conversational resolution agent (wk 10–12, optional).** LangGraph agent behind a
flag, A/B against the form dashboard with real PMs, same approve/edit/dismiss gate. Build only if
A–E are solid and the cost/benefit (below) justifies it.

---

## 6. Metrics & eval — same discipline as the Critic

Generation is not flag precision/recall; it needs its own measures, and where a mechanical trick
could inflate a number, it needs the control that exposes it:

- **Scenario acceptance rate**, split by accepted-as-is vs accepted-after-edit, with **edit
  distance** tracked — a scenario a human rewrote heavily is not a win, the same "real by
  construction" trap `flags.origin` guards against for flags.
- **AC coverage (recall-like):** share of approved AC clauses with ≥1 accepted scenario.
- **Hallucinated-step rate (precision-like):** steps referencing fields/entities absent from the
  AC/ticket, detected by the same span-verification used for flags.
- **Scaffold validity:** % of emitted scaffolds that parse/compile (a deterministic emitter
  should be ~100%; the metric catches regressions).
- **Conversational agent A/B (Milestone F):** pre-registered time-to-resolve,
  questions-per-ticket, PM-reported clarity, and completion rate vs the form — pre-registered so
  it cannot become a post-hoc story. Plus **cost per ticket**: a tool-calling agent can run
  10–50× a single classification call, which is a direct conflict with the GPT-only budget, so
  the agent is gated on measured cost, not assumed worth it.

---

## 7. Risks & guardrails specific to Phase 2

- **Ungated generation → flaky tests.** Mitigated by placeholder selectors, a deterministic
  emitter, and a mandatory human gate on both scenarios and scaffolds.
- **Scope creep into Phase 3.** PR-vs-spec verification, merge gating, and doc-sync stay out.
  The Atlassian Rovo Dev overlap on PR verification is unresolved — do not build Phase 3 without
  a specific differentiation answer.
- **Agent cost blow-up.** The conversational agent is optional, flagged, and gated on an A/B win
  and a cost ceiling — not the default path.
- **Spec drift.** Approved specs are pinned to a `ticket_version`; a new version marks them stale
  and the drift view surfaces them, rather than letting stale tests masquerade as coverage.
- **Single LLM provider.** Still acceptable in Phase 2; revisit before any hard-gating feature
  (Phase 3+), where one vendor's uptime becoming a merge dependency is a real risk.

---

## 8. Proposed first step

Start **Milestone A**: write migration `0003_specs.sql` (+ pgvector), scaffold
`packages/compiler` with the `GherkinScenarioSchema`, the `compile-gherkin-v1` prompt, call
logging and output/span validation, a `compile` subcommand in `scripts/ops.ts`, and unit +
injection tests — generating scenarios for one fixture ticket end to end. That mirrors exactly
how Phase 1's core was proven before any UI was built.
