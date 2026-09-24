# SpecFix

Ambiguity and gap detection for product requirements. A ticket goes in, structured flags come
out, a human reviewer resolves each one, and the ticket is marked ready for development.

## Source of truth

The **only** specification driving this repo is `specfix-implementation-plan.md` (Phase 1).
Anything from the earlier mentor/presentation documentation — Gherkin generation, Playwright
synthesis, GitHub PR compliance checks, FastAPI/Python, Gemini, SQLAlchemy, Docker execution
sandboxes, Kubernetes — is **not** part of this codebase and must not be added.

## Phase 1 scope

In scope: ticket ingestion, LLM ambiguity analysis producing structured flags, an Adversarial
Critic pass that filters false alarms before a human sees them, a review dashboard where a human
accepts/edits/dismisses each flag, an audit trail, and an eval harness that measures flag
precision and recall — and, on the Critic arm, tests that precision against a random-pruning
control.

Out of scope: test generation of any kind, PR analysis, Confluence, embeddings/pgvector,
non-English tickets, attachments and images, ticket comments as analysis input, compliance
certification. Writing to Jira is limited to a single event; see rule 3 below.

## Layout

```
packages/shared   zod schemas and shared types (Ticket, Flag, CriticReview, AnalysisResult)
packages/core     prompts, OpenAI client, analyze(), deliberate(), cost accounting
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

