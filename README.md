# SpecFix

Ambiguity and gap detection for product requirements. A ticket goes in, structured flags come
out, a human reviewer resolves each one, and the ticket is marked ready for development.

## Source of truth

Two specifications drive this repo: `specfix-implementation-plan.md` (Phase 0–1) and
`specfix-phase2-plan.md` (Phase 2). Phase 2 is now underway — Milestone A (the Spec
Compiler core) has landed — so Gherkin scenario generation, deterministic Playwright
scaffolds, the requirement→scenario→test traceability graph, and pgvector embeddings are
**in scope** and live under `packages/compiler` and migration `0003_specs.sql`. The
Phase-1 "do not add Gherkin / Playwright" rule was a Phase-1 scope guard; Phase 2 is
where those features are meant to land.

Still **not** part of this codebase, and not to be added: PR-vs-spec verification, hard
merge gating, doc auto-sync, autonomous/multi-agent workflows (Phase 3+), and the earlier
mentor/presentation stack that was never this project's — FastAPI/Python, Gemini,
SQLAlchemy, Docker execution sandboxes, Kubernetes. Generation stays gated behind a human
review step on every artifact; nothing here writes a test or a selector without a person
accepting it.

## Phase 1 scope

In scope: ticket ingestion, LLM ambiguity analysis producing structured flags, an Adversarial
Critic pass that filters false alarms before a human sees them, a review dashboard where a human
accepts/edits/dismisses each flag, an audit trail, and an eval harness that measures flag
precision and recall — and, on the Critic arm, tests that precision against a random-pruning
control.

## Phase 2 scope (now active)

In scope: Gherkin scenario generation from PM-approved, disambiguated acceptance criteria;
deterministic Playwright scaffold generation with **placeholder selectors only** (a human fills
in the real ones); a requirement→scenario→test traceability graph with pgvector embeddings for
fuzzy coverage and drift; and an optional conversational resolution agent A/B-tested against the
form dashboard. Every generated artifact keeps the Phase-1 human review gate. See
`specfix-phase2-plan.md` for the milestone sequence.

Out of scope (Phase 3+): PR-vs-spec verification, hard merge gating, Confluence, doc auto-sync,
autonomous or multi-agent workflows, non-English tickets, attachments and images, ticket
comments as analysis input, compliance certification. Writing to Jira is limited to a single
event; see rule 3 below.

## Conversational resolution agent (Phase 2, Milestone F — optional)

An alternative to the Review tab's form for deciding flags, behind a feature flag and off by
default. On a ticket's **Conversation** tab the agent asks about one open flag at a time; once
the reviewer has answered, it drafts the decision (accept with a resolution, reword the
question, or dismiss). Nothing changes until the reviewer applies the draft, and applying it
goes through the same `decideFlag` path as the form, so the audit trail and readiness events
are the same. The blind-first rule holds: the tab shows nothing until the reviewer's own gap
list is locked.

- Code: `packages/agent` (prompt `resolve-flag-v1`, one structured call per message, no tools),
  `packages/db/src/repositories/agent.ts`, `apps/web/app/tickets/[ticketId]/conversation`.
- Database: migration `0008_resolution_agent.sql` (conversations, messages, `agent_turn` calls).
- Configuration (`.env`):

  ```
  SPECFIX_RESOLUTION_AGENT=on      # shows the Conversation tab
  OPENAI_MODEL_AGENT=              # optional; defaults to OPENAI_MODEL_JUDGE
  AGENT_TIMEOUT_MS=30000           # per HTTP attempt
  AGENT_MAX_RETRIES=1              # transport retries per attempt
  AGENT_COST_CEILING_USD=0.25      # per conversation; the agent stops there
  ```

- Measures: the analytics page's "Form vs conversation" panel reports time to resolve per arm,
  completion rate, messages per conversation and cost. Reviewers choose the tab themselves, so
  this is observational; the randomized, pre-registered A/B the plan describes is not built.

## Layout

```
packages/shared   zod schemas and shared types (Ticket, Flag, CriticReview, AnalysisResult,
                  GherkinScenario, Scaffold)
packages/core     prompts, OpenAI client, analyze(), deliberate(), cost accounting
packages/compiler Spec Compiler: Gherkin generation (LLM) + deterministic Playwright scaffold
                  emitter. Returns data only, like core.
packages/agent    Conversational resolution agent (optional): one turn of a chat about one
                  flag. Returns data only, like core.
packages/db       SQL migrations and the tenant-scoped repository layer
packages/ingest   TicketSource interface, FileSource, (later) JiraSource + ADF normalizer
packages/eval     CLI: gold sets, flag matching, precision/recall, the random-pruning
                  control, report diffing
apps/web          Next.js dashboard (week 3)
apps/worker       BullMQ worker (week 6)
fixtures/         sample tickets, adversarial tickets, frozen gold sets, committed eval reports
```

## Getting started

```bash
npm install
```

```bash
npm run typecheck && npm test
```

Copy `.env.example` to `.env` and fill it in before running anything that talks to OpenAI or
Postgres.

## The two arms

The analysis pipeline runs in one of two arms, and the eval harness scores them separately.

| Arm | What runs | Report file |
|---|---|---|
| `single_shot` | Extractor only | `gold-v1__single-shot-v1.json` |
| `deliberated` | Extractor → Adversarial Critic | `gold-v1__single-shot-v1+deliberated.json` |

```bash
npm run eval -- run --set gold-v1 --prompt single-shot-v1
```

```bash
npm run eval -- run --set gold-v1 --prompt single-shot-v1 --deliberate
```

```bash
npm run eval -- compare --set gold-v1 --a single-shot-v1 --b single-shot-v1+deliberated
```

Both arms use the same gold set and the same extractor prompt, which is what makes the
difference between them attributable to the Critic rather than to anything else. See
[docs/deliberation-and-control.md](docs/deliberation-and-control.md) for how the Critic's
precision is tested, and why precision alone does not count as evidence.

## Non-negotiable rules

1. **No LLM output is used without schema validation.** Every response is parsed through a zod
   schema in `packages/shared` before it reaches the database or the UI.
2. **Ticket text is data, never instructions.** It is passed only in a user-role message inside
   delimiters. Never concatenated into a system prompt. This applies to the Critic pass too:
   the candidate flags it reviews are model output derived from ticket text, so they are
   delimiter-neutralized on the way in exactly as the ticket is.
3. **Exactly one write to Jira, at PM sign-off.** When the PM has resolved every flag and marks
   the ticket ready for development, SpecFix writes the disambiguated acceptance criteria back
   once. Nothing else writes to Jira — not a developer's commit, not a merged PR, not a feature
   built beyond the ticket's scope. A ticket that drifts from the shipped code is a
   conversation for the team to have, not a field for a tool to overwrite.
4. **Every tenant query goes through `packages/db` repositories** whose first argument is
   `tenantId`. The worker uses the service-role key, which bypasses RLS — so RLS is
   defense-in-depth, not the isolation mechanism. No raw database clients in `apps/*`.
5. **A human resolves every flag.** There is no auto-resolve path. The Critic is not an
   exception: it filters candidates before review, and every flag that survives still needs a
   human decision.
6. **Precision on the Critic arm is never quoted without its control.** Pruning raises precision
   mechanically — discarding flags at random does it too. A precision figure from a deliberated
   run is meaningless without the p-value beside it, and `buildReport` throws rather than
   produce one.

