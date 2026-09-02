# SpecFix — Implementation Plan (Phase 0–2)

## 0. Validation status — read before building

| Question | Status |
|---|---|
| Does a single-shot GPT prompt flag real ambiguity in requirement text? | Partially validated — self-scored 9.2/10 by the person who wrote both the tickets and the labels |
| Does an independent PM/engineer agree the flags are useful, not noise? | **Not yet validated** |
| What's the precision/recall split (false positives vs. missed gaps)? | **Not yet measured** — "9.2/10" doesn't tell us this |
| Has this run against a real team's live backlog (not self-authored tickets)? | Unclear — needs confirming |

**Gate before Phase 1 scales past a handful of tickets:** get 20-30 more tickets scored blind by someone who isn't you — ideally a PM or eng lead who wasn't involved in writing the prompt. Track precision (of flags raised, % a reviewer marks "real") and recall (of the reviewer's own list of gaps, % the model caught) separately. This is cheap to do and is the difference between "we validated the wedge" and "we validated that the model agrees with itself."

The plan below assumes this gate is being worked in parallel with early build-out, not skipped.

---

## 1. Problem statement (tightened)

Product requirements written as Jira tickets/user stories are frequently ambiguous or incomplete. Developers fill gaps with assumptions, producing software that passes unit tests but doesn't match business intent — discovered late, in QA or after release, when it's most expensive to fix.

This is a real, well-documented problem in requirements engineering (it's the reason tools like QVscribe and IBM's Requirements Quality Assistant exist in aerospace/defense contexts). The open question isn't whether ambiguity causes rework — it's whether a lightweight, Jira-native version of this check, priced and built for ordinary software teams rather than regulated-industry systems engineering, is a viable standalone product. That's what Phase 0-1 is testing.

**What we are not claiming yet:** a specific rework-reduction percentage. Every number in that direction is a hypothesis until a design partner gives us a baseline (see Section 8).

---

## 2. Solution — scoped to the actual wedge

**In scope for v1:** ingest a Jira ticket → flag ambiguity, missing information, vague/untestable language, contradictions, and unaddressed edge cases → human (PM) reviews and resolves each flag in a dashboard → ticket is marked ready for development.

**Explicitly out of scope for v1** (deferred, see roadmap): Gherkin/Playwright generation, PR-vs-spec verification, doc auto-sync, multi-agent autonomous workflows. Every one of these is a real, larger, harder problem, and building them before the core flagging loop is independently validated is how a six-person team ends up with four half-finished products instead of one that works.

---

## 3. Phased roadmap

### Phase 0 (running now / just completed) — Prompt validation
- Raw script, no infra: ticket text in → flags out.
- **Next step, in progress:** independent scoring by someone other than the prompt author, on 20-30 additional tickets, tracking precision and recall separately.

### Phase 1 (8-10 weeks) — MVP: ambiguity detection + review dashboard
- Jira API ingestion (pull ticket title, description, acceptance criteria on demand or via webhook).
- LLM analysis pipeline (see Section 5) producing structured flags: category, what's unclear, why it matters, a specific question for the PM.
- Review dashboard: ticket + flags side by side, one-click approve/edit/dismiss per flag, audit trail of decisions.
- Track: flag precision, flag recall (against reviewer's own list), time-to-ready per ticket, questions-per-ticket before vs. after.
- **No test generation, no PR analysis, no write-back to Jira without explicit human approval.**

### Phase 2 (8-12 weeks) — Gherkin/Playwright scaffold generation + traceability
- Only start this once Phase 1 flag precision is holding up on real, independently-scored tickets.
- Generate Gherkin + Playwright scaffolds from PM-approved (disambiguated) requirements, with placeholder selectors — human fills in real ones, exactly as every competitor in this space (Qase, TestCollab) already does, because ungated generation produces flaky/wrong tests.
- Build the requirement → test → code traceability graph.
- Introduce the single conversational agent (Section 6) as an alternative UI for flag resolution — optional, tested against the form-based dashboard, not a replacement by default.

### Phase 3+ (not scoped in detail here, gated on data)
- Advisory (non-blocking) PR-vs-spec comments, only after Phase 2 traceability data exists.
- Hard merge-gating, opt-in per team, only after measured false-positive rate is low.
- Doc-sync proposals (never auto-write).

---

## 4. System architecture (Phase 1-2)

```
Jira API / webhook
        │
        ▼
Requirement Parser (LLM call, gpt-4o-mini for extraction,
gpt-4o for the ambiguity/edge-case judgment pass)
        │
        ▼
Structured flags → Postgres (ticket, flag, category, status, reviewer decision)
        │
        ▼
Review Dashboard (Next.js) — PM approves/edits/dismisses each flag
        │
        ▼ (Phase 2 only, on approval)
Spec Compiler → Gherkin + Playwright scaffold (placeholders for selectors)
        │
        ▼
Traceability store (Postgres + pgvector for requirement/test embeddings)
```

Design principles carried through from earlier review:
- Human review gate after every AI-generated artifact — no exceptions in Phase 1-2.
- Nothing writes back to Jira/Confluence without an explicit human click.
- Tenant isolation is a Day-1 schema decision (row-level security keyed on tenant_id), not a retrofit — this cannot be added safely later once real customer data is in the database.

---

## 5. Tech stack — GPT-only, lean for Phase 0-2

| Layer | Choice | Why |
|---|---|---|
| LLM | OpenAI only. `gpt-4o-mini` for extraction/parsing (cheap, high volume); `gpt-4o` for the actual ambiguity judgment call that a human will act on | Single provider per budget constraint. Tiering by task, not by vendor, is the actual lever for cost control here. |
| Embeddings | `text-embedding-3-small` | pgvector is fine under ~1M vectors at this stage; the small model is enough and meaningfully cheaper than `-large`. |
| Orchestration | BullMQ (Redis-backed) | Phase 1-2 is a 3-5 step linear/branching pipeline. Temporal and LangGraph both solve problems (complex durable workflows, multi-agent branching) you don't have yet — adding them now is complexity with no current payoff. |
| Database | Supabase (Postgres + pgvector + auth + storage in one bill) | Avoids running separate auth (Clerk) and Postgres (RDS) services that do overlapping jobs. Plain Postgres underneath — can split out later with no rewrite. |
| Frontend | Next.js + Tailwind + shadcn/ui | shadcn components are owned in your codebase, which matters because the review queue and diff-style flag UI need real customization, not off-the-shelf widgets. |
| Deploy | Railway or Fly.io | Skip AWS/ECS/Fargate/Pulumi until there's an enterprise deal that specifically requires AWS. That stack is real, correct engineering — for a company with paying customers. Right now it's 15 vendor bills before product-market fit. |
| LLM call logging | A Postgres table (prompt version, input, output, reviewer verdict) | This *is* your eval harness. Don't pay for Langfuse/Braintrust until call volume or team size makes a dedicated tool worth it — the eval harness only needs to answer "did this prompt change help or hurt," and a table plus a script does that. |
| Compliance tooling (Vanta, pen-test budget, SOC 2 prep) | Deferred | Real cost, real eventual necessity — but only once an enterprise prospect asks for it. Spending against this now is spending against a customer you don't have yet. |

**What's explicitly cut from earlier proposals, and why:** Temporal (Phase 3+ if ever), LangGraph (Phase 2+ at earliest, and only for the one conversational agent, not five), Clerk (redundant with Supabase auth), AWS/Pulumi/Fargate (defer to first enterprise deal), Langfuse/Braintrust (a Postgres table does the job at this scale), GPT-4o + Claude router (single provider now, revisit before any hard-gating feature ships — a gate that depends on one vendor's uptime is a real risk, just not this quarter's risk).

---

## 6. Agentic layer — one agent, gated, not five

The five-agent vision (deep research agent, browser-exploring test generator, autonomous PR reviewer, autonomous doc-writer, conversational resolver) is a reasonable Phase 3-4+ ambition but wrong for now, for three concrete reasons:

1. **It assumes the core loop already works.** None of it should be built before Phase 1's flag precision/recall is independently confirmed.
2. **Cost.** A single-shot classification call and a multi-turn tool-calling agent (search Confluence, search past tickets, inspect a codebase, hold a conversation) are not the same order of magnitude in token spend — the agent flow can run 10-50x more expensive per ticket. That's a direct conflict with a GPT-only, tight-budget constraint.
3. **Trust regression risk.** Any agent that writes back to Jira without an explicit per-decision human approval step reintroduces the exact failure mode (autonomous write to source of truth) that the human-review-gate principle exists to prevent.

**What's actually justified for Phase 2:** one conversational resolution agent, as an *alternative* interface to the same approve/edit/dismiss dashboard — not a replacement, not autonomous. It asks the PM the flagged questions one at a time in natural language instead of a form, and drafts the resolved acceptance criteria for the PM to approve before anything is written to Jira. Same human gate, different UI. Test it against the form-based dashboard with real PMs before assuming it's better — conversational isn't automatically higher-conversion than a well-designed form, that's a UX hypothesis, not a given.

Everything else in the five-agent list (codebase-cross-referencing research agent, browser-automation test generator, autonomous PR reasoning agent, autonomous doc-writer) stays out of scope until Phase 1-2 data exists to justify the added cost and risk.

---

## 7. Features by phase (concrete list)

**Phase 1:**
- Jira ticket ingestion (manual trigger + webhook)
- Ambiguity/gap flagging across: missing information, vague language, contradictions, unhandled edge cases, security/compliance gaps, untestable criteria
- Review dashboard: side-by-side view, approve/edit/dismiss per flag, resolution audit trail
- Metrics dashboard: flag precision/recall, time-to-ready, questions-per-ticket

**Phase 2 (gated on Phase 1 data):**
- Gherkin generation from approved requirements
- Playwright scaffold generation with placeholder selectors
- Requirement → test traceability graph
- Optional conversational resolution agent (A/B tested against the form dashboard)

**Phase 3+ (not detailed, gated on Phase 2 data):**
- Advisory PR-vs-spec comments
- Opt-in hard merge gating
- Doc-sync proposals (human-approved only)

---

## 8. Metrics and eval framework (no invented numbers)

| Metric | How it's measured | Why it matters |
|---|---|---|
| Flag precision | % of raised flags an independent reviewer marks "real issue" | Determines noise level / alert fatigue risk |
| Flag recall | % of the reviewer's own gap list the model caught | Determines actual coverage |
| Time-to-ready | Time from ticket creation to "marked ready for dev," before vs. after tool | Real, measurable proxy for the rework-prevention thesis |
| Questions-per-ticket | Developer questions asked post-handoff, before vs. after | Leading indicator, easier to collect than full rework cost |
| Rework rate (PRs rejected in QA for "missing requirement" reasons) | Requires a design partner baseline in Phase 0/1 | This is the number that eventually supports a rework-reduction claim — not before it's measured |

No "50% reduction" or similar number goes into any external material until it's derived from this table with a real design partner's data, not assumed.

---

## 9. Security & data handling (Day-1 constraints, not retrofits)

- Row-level security in Postgres, tenant_id on every table, enforced at the query layer — decided now, because retrofitting isolation after real customer data exists is far riskier than building it in from the first schema migration.
- Treat all ticket/PR text as untrusted input to the LLM: separate system/user message roles, never concatenate raw ticket text into a system prompt, validate LLM output against an expected schema before using it, log every LLM call (input, output, prompt version) for audit and debugging.
- No SOC 2 / formal compliance program yet — noted as a known gap to close before any enterprise pilot that requires it, not before.

---

## 10. Competitive position (stated plainly, not oversold)

- **Not claiming to be first.** QVscribe/IBM RQA have done NLP-based requirement quality analysis for over a decade, in aerospace/defense/regulated contexts.
- **Real differentiation claim:** Jira-native, lightweight, priced and built for ordinary software teams rather than enterprise systems-engineering budgets.
- **Real, unresolved platform risk:** Atlassian's own Rovo Dev already validates code changes against Jira acceptance criteria natively — meaning Objective 3 from the original plan (PR-vs-spec verification) is being built by the platform vendor itself. This doesn't kill the ambiguity-detection wedge, but it means Phase 3 (PR verification) needs a real "why us, not Atlassian" answer before it gets built, not after.

---

## 11. Team & rough timeline

Phase 1 (8-10 weeks): 1 backend/infra engineer, 1 ML/prompt engineer, 1 frontend engineer, part-time PM/design-partner liaison whose job is collecting the precision/recall/baseline data in Section 8 — without this role, the metrics table stays empty and every later claim stays unsubstantiated.

---

## 12. Open risks

- Precision/recall on real (not self-authored) tickets is unknown — the immediate next step, not a later concern.
- Single LLM provider = no fallback; acceptable now, needs revisiting before any hard-gating feature (Phase 3+) ships.
- Atlassian platform risk on the PR-verification piece is unresolved, not mitigated — don't build Phase 3 without a specific answer to it.
- No design partner confirmed yet as of this plan — Phase 1 dashboard work can proceed in parallel with securing one, but the metrics in Section 8 are meaningless without real ticket flow from an actual team.
