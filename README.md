# SpecFix

[![CI](https://github.com/Raghav007-maker/specfix-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/Raghav007-maker/specfix-ai/actions/workflows/ci.yml)
[![Deploy](https://github.com/Raghav007-maker/specfix-ai/actions/workflows/deploy.yml/badge.svg)](https://github.com/Raghav007-maker/specfix-ai/actions/workflows/deploy.yml)

**Live app: <https://specfix-app-ub.azurewebsites.net>**

Ambiguity and gap detection for product requirements. A ticket goes in, structured flags come
out, a human reviewer resolves each one, and the ticket is marked ready for development. Around
that review, SpecFix plans the work: a board with sprints and tasks linked to the specs and
tests they came from, and a team with clear roles.

## What it does

- **Spec review** — tickets come in from Jira or a file. The model lists what a ticket leaves
  unsaid, an Adversarial Critic drops false alarms, and a person accepts, edits or dismisses
  every flag. The reviewer writes their own gaps first, before seeing the model's (blind-first).
- **Specs and tests** — approved acceptance criteria become Gherkin scenarios and Playwright
  scaffolds with placeholder selectors; CI results come back in and link to each scenario.
- **Work tracking** — per project: summary, board, backlog, list, calendar, sprints, tasks with
  comments and links, and time logging (1–1440 minutes per entry).
- **Workspaces and roles** — see the table below. Each project has its own admins and
  reviewers; the Team page shows who is on what, with assigned, in-progress, done and overdue
  work, hours and last activity.
- **Joining** — find a team by name and ask to join (the owner approves); ask to join a project
  (its admin approves); admins ask the owner for a new project. Everyone sets a display name
  (at sign-up or in Settings → Profile, with a photo) so teammates can find them.
- **Project status** — Running (yellow), On hold, Completed (green) or Archived; only an owner
  changes it.
- **Workspaces and plans** — after sign-up a person either creates a workspace (a one-time ₹25
  fee; it opens when the fee is paid, on the Free plan) or continues as a reviewer free of
  charge and asks to join an existing one. Free allows 5 projects and 5 admins and reviewers;
  Pro (paid by the owner only) allows unlimited projects and 10 admins and reviewers. Only the
  workspace owner sees pricing; only SpecFix's own team (`SPECFIX_OWNER_EMAILS`) approves
  payments and creates workspaces free.
- **Sign-in** — email and password or Google, optional two-step verification, and a Cloudflare
  Turnstile "verify you are human" check. Signed-out visitors opening any app link see the
  landing page.
- **Integrations** — Jira (OAuth, webhooks, one write-back at sign-off), a GitHub App, and
  payments for plans (Razorpay, UPI).

### Roles

| | Owner | Admin (of a project) | Reviewer |
|---|---|---|---|
| Sees | every project | projects they are in | projects they are in |
| Creates projects | yes, naming the admin | asks the owner | — |
| Adds people to a project | admins and reviewers | reviewers (finds them by name) | — |
| Approves | team joins, project requests | requests to join their project | — |
| Project status | changes it | sees it | sees it |
| Tracks | admins and reviewers | reviewers | own work |

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
SQLAlchemy, Docker execution sandboxes, Kubernetes. (Docker is used only to run the
disposable test database; the app itself deploys without containers.) Generation stays gated behind a human
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
packages/ingest   TicketSource interface, FileSource, JiraSource + ADF normalizer
packages/sync     Jira and GitHub sync, the queue worker's jobs, notifications, email,
                  and the single Jira write-back (writeback.ts)
packages/eval     CLI: gold sets, flag matching, precision/recall, the random-pruning
                  control, report diffing
apps/web          Next.js app: landing page, review dashboard, projects, team, settings
scripts/worker.ts BullMQ worker entry (npm run worker)
fixtures/         sample tickets, adversarial tickets, frozen gold sets, committed eval reports
docs/             setup guides (GitHub App)
```

## Getting started

```bash
npm install
```

```bash
npm run typecheck && npm test
```

Copy `.env.example` to `.env` and fill it in before running anything that talks to OpenAI or
Postgres. Then start the app at <http://localhost:3000>:

```bash
npm run dev
```

Database migrations live in `packages/db/migrations` (`00NN_*.sql`). On the team's Supabase
database a person runs them, before the code that needs them is deployed:

```bash
npm run db:migrate
```

### Test database (Docker)

Database tests need a disposable Postgres; without one they are skipped. `docker-compose.yml`
starts the same pgvector image CI uses, on port 54329, holding nothing once stopped. Never run
tests against the Supabase database in `.env`.

```bash
docker compose up -d --wait testdb
```

```bash
export SPECFIX_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/specfix_test
export DATABASE_URL=$SPECFIX_TEST_DATABASE_URL
npm run db:migrate -- --shim && npm test
```

In PowerShell set the two variables with `$env:SPECFIX_TEST_DATABASE_URL = '...'` and
`$env:DATABASE_URL = $env:SPECFIX_TEST_DATABASE_URL`. Stop it with `docker compose down`.

## Sign-in: Google and two-step verification

Both run on Supabase Auth; SpecFix stores no secrets for them.

- **Human check (Cloudflare Turnstile)**: create a widget in Cloudflare (Turnstile → Add widget,
  Managed mode) with the app's hostname, plus `localhost` for local work. Put its **site key** in
  `TURNSTILE_SITE_KEY` (in `.env`, and in Azure's app settings), restart the app and check the
  box shows on `/login`. Only then paste its **secret key** into Supabase (Authentication →
  Attack Protection → CAPTCHA, provider Turnstile); turning that on first blocks every sign-in.

- **Two-step verification** (Settings → Security): a 6-digit code from Google Authenticator,
  Microsoft Authenticator or Authy after the password or Google sign-in. Supabase's
  authenticator (TOTP) factor is on by default; check Authentication → Multi-Factor if not. A
  user who loses their phone is unlocked by deleting their factor in the Supabase dashboard
  (Authentication → Users → the user → MFA factors).
- **Continue with Google**: create an OAuth client in Google Cloud (Web application, redirect
  URI `https://<project>.supabase.co/auth/v1/callback`), paste its ID and secret into Supabase
  (Authentication → Sign In / Providers → Google), and add `<app address>/auth/callback` to
  Authentication → URL Configuration → Redirect URLs. Then set in `.env`:

  ```
  # Shows "Continue with Google" on the sign-in page. 1 = on; leave unset until Supabase is set up.
  GOOGLE_SIGN_IN_ENABLED=1
  ```

  The return address is `PUBLIC_BASE_URL` (or `http://localhost:3000` when unset).

## Deploy

Pushing to `main` runs two GitHub Actions workflows:

- **ci** (`.github/workflows/ci.yml`) — format, lint, typecheck and the full test suite against
  a pgvector Postgres.
- **deploy** (`.github/workflows/deploy.yml`) — builds the Next.js app (`output: 'standalone'`)
  and a one-file worker bundle, and uploads both as zips to Azure App Service:
  `specfix-app-ub` (the web app, <https://specfix-app-ub.azurewebsites.net>) and
  `specfix-app-ub-worker`.

Runtime settings (the names in `.env.example`) live in Azure → App Service → Settings →
Environment variables. Run any new migration (`npm run db:migrate`) before the deploy that
needs it.

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
difference between them attributable to the Critic rather than to anything else. The Critic's
precision is always reported beside a random-pruning control and its p-value
(`packages/eval`); see rule 6 below for why precision alone does not count as evidence.

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

