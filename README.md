# SpecFix

Ambiguity and gap detection for product requirements. A ticket goes in, structured flags come
out, a human reviewer resolves each one, and the ticket is marked ready for development.

## Source of truth

The **only** specification driving this repo is `specfix-implementation-plan.md` (Phase 1).
Anything from the earlier mentor/presentation documentation — Gherkin generation, Playwright
synthesis, GitHub PR compliance checks, FastAPI/Python, Gemini, SQLAlchemy, Docker execution
sandboxes, Kubernetes — is **not** part of this codebase and must not be added.

## Phase 1 scope

In scope: ticket ingestion, LLM ambiguity analysis producing structured flags, a review
dashboard where a human accepts/edits/dismisses each flag, an audit trail, and an eval harness
that measures flag precision and recall.

Out of scope: test generation of any kind, PR analysis, Confluence, writing anything back to
Jira, embeddings/pgvector, non-English tickets, attachments and images, ticket comments as
analysis input, compliance certification.

## Layout

```
packages/shared   zod schemas and shared types (Ticket, Flag, AnalysisResult)
packages/core     prompts, OpenAI client, analyze(), cost accounting
packages/db       SQL migrations and the tenant-scoped repository layer
packages/ingest   TicketSource interface, FileSource, (later) JiraSource + ADF normalizer
packages/eval     CLI: gold sets, flag matching, precision/recall metrics, report diffing
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

## Non-negotiable rules

1. **No LLM output is used without schema validation.** Every response is parsed through a zod
   schema in `packages/shared` before it reaches the database or the UI.
2. **Ticket text is data, never instructions.** It is passed only in a user-role message inside
   delimiters. Never concatenated into a system prompt.
3. **Nothing is written back to Jira.** Phase 1 is read-only against the source of truth.
4. **Every tenant query goes through `packages/db` repositories** whose first argument is
   `tenantId`. The worker uses the service-role key, which bypasses RLS — so RLS is
   defense-in-depth, not the isolation mechanism. No raw database clients in `apps/*`.
5. **A human resolves every flag.** There is no auto-resolve path.
