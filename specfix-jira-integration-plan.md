# SpecFix — Jira Integration Plan (live sync, write-back, notifications)

> Companion to `specfix-implementation-plan.md` (Phase 0–1) and `specfix-phase2-plan.md`.
> This plan covers the two gaps that keep SpecFix from being used day to day as a site that sits
> beside Jira: **(1) tickets arriving from Jira by themselves**, and **(2) people being pulled
> back to SpecFix when something needs them** (write-back + notifications).
>
> Status: approved for build (decisions D4, O1, O2 settled 2026-10-27). Nothing here is built yet. Today tickets enter only through `FileSource`
> (`packages/ingest`) via `npm run ops -- seed`.

---

## 0. What already exists and is reused

| Piece | Where | Why it matters here |
|---|---|---|
| `TicketSource` interface | `packages/ingest/src/types.ts` | `JiraSource` implements it; nothing downstream changes. |
| `NormalizedTicket` (zod) | `packages/shared/src/ticket.ts` | Already names `packages/ingest/src/adf.ts` as the ADF flattener. |
| Versioned ingest + stale flags | `packages/db/src/repositories/tickets.ts` | A webhook that changes only the assignee is a no-op; a text change creates a new version and marks old flags stale. This is exactly the sync semantics we need. |
| Jira columns on `projects` | `0001_init.sql` | `source_type='jira'`, `jira_cloud_id`, `jira_project_key` + check constraint. |
| Per-tenant monthly token cap | `tenants.monthly_token_cap` | Protects against a large backfill burning the LLM budget. |
| Non-negotiables | Phase 2 plan §1 | Every new table has `tenant_id` + RLS; access only via `packages/db` repositories; ticket text is data, never instructions. |

---

## 1. Decisions (recommended defaults — change before Milestone A if you disagree)

**D1. Job queue: a Postgres table, not BullMQ/Redis (for now).**
The Phase 1 plan names BullMQ, but no queue exists yet and current volume is tiny. A
`sync_jobs` table drained with `SELECT … FOR UPDATE SKIP LOCKED` gives retries, dedupe and
an audit trail with zero new vendors. The worker interface (`enqueue`, `claim`, `complete`,
`fail`) is kept narrow so swapping to BullMQ later touches one module.

**D2. Webhooks are signals, not data.**
On every webhook we verify it, record it, enqueue `issue_sync(issueId)`, and return `200`
immediately. The worker re-fetches the issue through the REST API. This means we never trust
payload contents, we tolerate missing/out-of-order/duplicate deliveries, and the same code path
serves webhooks, backfill and reconciliation.

**D3. Read and write grants are separate tokens.** (Honours Phase 1 plan §9.)
"Connect Jira" asks only for read scopes. Write-back is a separate, later consent an admin opts
into; its token is stored in its own row and is loaded by exactly one function, reachable only
from the authenticated PM sign-off server action.

**D4. Jira-side status visibility — DECIDED: §9 stays strict.**
The worker never writes to Jira. The only Jira writes are the comment + `specfix-ready` label
made at PM sign-off (Milestone D). Everything else ("needs decisions", "went stale", "stuck")
reaches people through the SpecFix inbox and email (Milestone E). A read-only Forge issue glance
that pulls status from SpecFix remains a possible later addition and needs no Jira write.

**D5. Backfill imports everything but analyzes selectively.**
Importing is cheap; analysis costs money. Default: analyze only unresolved issues of type
Story/Task updated in the last 30 days (configurable JQL), and always respect the tenant token cap.

---

## 2. Jira Cloud surface we use

All REST calls go to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`.

| Need | API | Notes |
|---|---|---|
| Connect | OAuth 2.0 (3LO): `auth.atlassian.com/authorize` → `/oauth/token` | Signed `state` (tenant id + nonce, HMAC) to stop CSRF. |
| Pick site | `GET api.atlassian.com/oauth/token/accessible-resources` | Returns `cloudId` + site URL; a user can have several sites. |
| Read scopes | `read:jira-work`, `read:jira-user`, `manage:jira-webhook`, `offline_access` | `offline_access` gives refresh tokens. Atlassian **rotates** refresh tokens: always persist the new one in the same transaction. |
| Write scope (D3) | `write:jira-work` | Separate grant. |
| List projects / fields | `GET /project/search`, `GET /field` | Field list is used to let the admin pick an "Acceptance Criteria" custom field if they have one. |
| Backfill + reconcile | `POST /search/jql` with `nextPageToken` | Old `/search` is deprecated — do not build on it. |
| One issue | `GET /issue/{id}?fields=summary,description,issuetype,status,reporter,assignee,updated,{acField}` | |
| Live updates | Dynamic webhooks: `POST /webhook` with a JQL filter (`project = KEY`), events `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted` | Dynamic webhooks **expire after 30 days**; refresh with `PUT /webhook/refresh`. |
| Write-back | `POST /issue/{id}/comment` (ADF body), `PUT /issue/{id}` with `update.labels` | Only from the sign-off path. |
| Identity | `GET api.atlassian.com/me` | Gives `account_id` + email for "Login with Atlassian" mapping later. Issue payloads often hide email. |

Rate limits: honour `429` + `Retry-After`; back off with jitter in the client, not in callers.

> **Spike before Milestone C (half a day):** confirm the exact verification scheme for OAuth-app
> dynamic webhooks (signed JWT in the `Authorization` header, verified with the app's client
> secret) and the fields present in the payload, against current Atlassian docs. D2 makes us
> robust to thin payloads either way; verification must still be exact.

---

## 3. Schema — one migration per milestone

> **As built (Milestone A, `0010_jira_connections.sql`):** `jira_connections` holds **one row per
> (tenant, grant kind)**, not per site — Atlassian rotates refresh tokens, so per-site copies of one
> grant would invalidate each other on the first refresh. The chosen site is a column
> (`cloud_id`/`site_url`/`site_name`, null until picked; one site per tenant for now). The OAuth
> state is not stored: it is HMAC-signed (key derived from `TOKEN_ENCRYPTION_KEY`) and pinned to
> an httpOnly cookie. The sketch below is the original full-scope design; later milestones add
> their tables in their own migrations (`0011+`).

All tables carry `tenant_id` with RLS enabled. Token tables have **no** policy for
`authenticated` at all — only the service role reads them.

```sql
-- One row per (tenant, Jira site, grant kind). Tokens encrypted at rest (AES-256-GCM,
-- key from TOKEN_ENCRYPTION_KEY; key id stored so a key change is detected).
create table jira_connections (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  cloud_id           text not null,
  site_url           text not null,
  grant_kind         text not null check (grant_kind in ('read', 'write')),
  scopes             text[] not null,
  access_token_enc   bytea not null,
  refresh_token_enc  bytea not null,
  key_id             text not null,
  expires_at         timestamptz not null,
  status             text not null default 'active' check (status in ('active', 'revoked', 'error')),
  connected_by       uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, cloud_id, grant_kind)
);

create table jira_webhooks (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  connection_id      uuid not null references jira_connections (id) on delete cascade,
  project_id         uuid not null references projects (id) on delete cascade,
  jira_webhook_id    bigint not null,
  jql                text not null,
  expires_at         timestamptz not null,
  unique (tenant_id, connection_id, jira_webhook_id)
);

alter table projects
  add column jira_connection_id uuid references jira_connections (id) on delete set null,
  add column ac_field_id        text,          -- e.g. customfield_10042; null = parse from description
  add column analyze_jql        text,          -- D5 filter; null = default
  add column last_synced_at     timestamptz,
  add column sync_status        text not null default 'idle'
    check (sync_status in ('idle', 'backfilling', 'live', 'error'));

alter table tickets
  add column issue_type           text,
  add column status_name          text,
  add column reporter_account_id  text,
  add column assignee_account_id  text,
  add column archived_at          timestamptz;   -- set on jira:issue_deleted or move out of project

-- Postgres job queue (D1).
create table sync_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  kind         text not null check (kind in (
                 'backfill', 'issue_sync', 'reconcile', 'refresh_webhooks', 'analyze', 'notify_digest')),
  payload      jsonb not null default '{}',
  dedupe_key   text,
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts     int  not null default 0,
  run_after    timestamptz not null default now(),
  last_error   text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create unique index sync_jobs_dedupe on sync_jobs (tenant_id, dedupe_key) where status in ('queued', 'running');
create index sync_jobs_claim on sync_jobs (run_after) where status = 'queued';

-- Raw delivery log: idempotency + audit. Payload hash only, not the body.
create table jira_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  event         text not null,
  issue_id      text,
  payload_hash  text not null,
  received_at   timestamptz not null default now(),
  unique (tenant_id, payload_hash)
);

-- Every write SpecFix makes to Jira, for audit and to make sign-off idempotent.
create table jira_writebacks (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  ticket_id          uuid not null references tickets (id) on delete cascade,
  ticket_version_id  uuid not null references ticket_versions (id) on delete cascade,
  kind               text not null check (kind in ('comment', 'label')),
  jira_ref           text,               -- comment id, or label value
  status             text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error              text,
  requested_by       uuid not null references auth.users (id),
  created_at         timestamptz not null default now(),
  unique (tenant_id, ticket_version_id, kind)
);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('flags_ready', 'flags_stale', 'ticket_stuck', 'signed_off')),
  ticket_id   uuid references tickets (id) on delete cascade,
  payload     jsonb not null default '{}',
  read_at     timestamptz,
  emailed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_inbox on notifications (tenant_id, user_id, created_at desc) where read_at is null;

create table notification_prefs (
  tenant_id     uuid not null references tenants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  email_instant boolean not null default true,
  email_digest  text    not null default 'daily' check (email_digest in ('off', 'daily', 'weekly')),
  primary key (tenant_id, user_id)
);
```

RLS: `notifications` / `notification_prefs` readable and updatable by `auth.uid() = user_id`
within a tenant the user belongs to; everything else tenant-scoped read for members; token
tables service-role only.

---

## 4. Code layout

```
packages/ingest/src/
  adf.ts                 ADF → plain text; pulls an "Acceptance Criteria" section out of the
                         description when no ac_field_id is set (heading match, case-insensitive)
  jira/client.ts         fetch wrapper: base URL by cloudId, token refresh (rotating), 429 backoff
  jira/oauth.ts          authorize URL, code exchange, refresh, accessible-resources
  jira/source.ts         JiraSource implements TicketSource (list via /search/jql, get by id)
  jira/normalize.ts      Jira issue JSON → NormalizedTicket (+ issue_type, status, reporter, assignee)
  jira/webhooks.ts       register / refresh / delete; verify incoming signature
  jira/writeback.ts      comment + label (ADF builder for clarified AC)

packages/db/src/repositories/
  jira.ts                connections (encrypt/decrypt lives here, nowhere else), webhooks, events
  jobs.ts                enqueue / claim (SKIP LOCKED) / complete / fail with backoff
  writebacks.ts
  notifications.ts

apps/web/app/api/jira/
  connect/route.ts       GET → redirect to Atlassian (admin/owner only)
  callback/route.ts      GET → exchange code, store read grant, go to site/project picker
  webhook/route.ts       POST → verify, record event, enqueue issue_sync, 200 fast
apps/web/app/settings/integrations/   Connect/disconnect, pick site + projects, AC field, analyze JQL,
                                     enable write-back (second consent), sync status
apps/web/app/inbox/                   in-app notifications

apps/worker/              new: long-running Node process
  src/main.ts             poll loop: claim → dispatch by kind → complete/fail
  src/handlers/*.ts       backfill, issue_sync, reconcile, refresh_webhooks, analyze, notify_digest
  src/schedule.ts         every 15 min enqueue reconcile per live project; daily refresh_webhooks
                          (refresh anything expiring within 7 days) and notify_digest
```

The worker reuses what `scripts/ops.ts` does today (ingest → embed → analyze), lifted into
functions both can call, so the CLI and the worker never drift.

---

## 5. Flows

**Connect (Milestone A)**
1. Owner/admin clicks *Connect Jira* → `/api/jira/connect` builds the authorize URL with HMAC-signed `state`.
2. Callback verifies `state`, exchanges the code, calls accessible-resources, stores an encrypted read grant.
3. Picker: choose site → choose projects (creates `projects` rows with `source_type='jira'`) → optional AC field.
4. Enqueue `backfill` per project; register a dynamic webhook per project.

**Backfill (Milestone B)**
`/search/jql` pages of 100 → `normalize` → `ingestTicket` (idempotent) → embed → if it matches
`analyze_jql`/D5 and the token cap allows, enqueue `analyze`. Checkpoint `nextPageToken` in the
job payload so a crash resumes instead of restarting. Project goes `backfilling → live`.

**Live sync (Milestone C)**
Webhook → verify → insert `jira_webhook_events` (duplicate = ignore) → enqueue
`issue_sync` with `dedupe_key = issue:<id>` (bursts of edits collapse into one job).
Handler re-fetches the issue: 404 or moved out of project → set `archived_at`;
otherwise `ingestTicket`; if a new version was created → enqueue `analyze` and notify the
owner that previous decisions went stale. `reconcile` runs JQL `updated >= last_synced_at - 5m`
to catch missed deliveries.

**Sign-off write-back (Milestone D)**
PM clicks *Ready for development* → server action checks role + that the version is current
and has no open flags → inserts `jira_writebacks` (`pending`; unique per version makes double
clicks harmless) → posts an ADF comment with the clarified acceptance criteria and a link back
→ adds label `specfix-ready` → marks `done`. Failure is shown to the PM with a retry button; it
never silently fails. If no write grant exists, the button still signs off in SpecFix and
offers "copy AC" instead.

**Notifications (Milestone E)**
Triggers, each creating `notifications` rows and optionally an instant email:
- `flags_ready` — analysis finished with ≥1 surviving flag → ticket owner.
- `flags_stale` — Jira edit invalidated decisions → ticket owner.
- `ticket_stuck` — open flags untouched for N days (from digest job).
- `signed_off` — sent to the assignee so the developer knows the spec is final.

*Ticket owner*, until roles land (gap #5): the SpecFix user mapped from `reporter_account_id`
if one exists, else the project's owner/admins.

**Email transport — DECIDED: Gmail SMTP via Nodemailer (App Password).** Sent only from the
worker, behind a one-function `sendMail(to, subject, html, text)` module in
`apps/worker/src/mail.ts` so the transport can be swapped (Postmark/SES/Workspace relay)
without touching callers. Config:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465            # implicit TLS (secure: true)
SMTP_USER=<sender gmail address>
SMTP_PASS=<16-char Google App Password; requires 2-Step Verification on that account>
MAIL_FROM="SpecFix <sender gmail address>"
MAIL_ENABLED=1           # 0 = log emails instead of sending (local dev, CI)
```

Constraints that shape the design:
- Gmail caps daily sends (roughly 500/day on a personal account, higher on Workspace) — so
  instant emails are rate-limited per user (one per ticket per hour) and everything else goes
  into the digest. Hitting the cap must degrade to in-app only, never fail the job.
- Use a dedicated sender account, not anyone's personal inbox; the App Password is a secret
  held only in the worker's env.
- Mail comes from `@gmail.com`, so some corporate filters may junk it. Acceptable for pilots;
  revisit before the first paying customer.
- Every email carries a link to the ticket and a one-click link to notification preferences.

---

## 6. Milestones and exit criteria

| | Scope | Exit criteria |
|---|---|---|
| **A. Connect** (~1 wk) | Migration 0010, OAuth, token encryption, settings page, site/project picker | Admin connects a real Jira Cloud site; tokens encrypted at rest; refresh rotation covered by a test; non-admin cannot reach `/api/jira/connect`. |
| **B. Backfill** (~1 wk) | `adf.ts`, `JiraSource`, job queue, `apps/worker`, backfill handler | 500-issue project imports with resume-after-kill; re-running is a no-op (zero new versions); analysis respects D5 and the token cap. |
| **C. Live sync** (~1 wk) | Webhook spike, receiver, issue_sync, reconcile, webhook refresh, archive on delete | Edit in Jira shows in SpecFix in < 1 min; duplicate and forged deliveries rejected (tests); killing the receiver for an hour loses nothing after reconcile. |
| **D. Write-back** (~4 days) | Second consent, writeback path, UI states | Comment + label appear on the Jira issue; double-click writes once; write token unreachable from worker code (enforced by a lint/import rule or test). |
| **E. Notifications** (~1 wk) | In-app inbox, email provider, prefs, digest | Each trigger has a test; unsubscribe/prefs honoured; no user gets more than one instant email per ticket per hour. |

### As built — Milestone B

- **Migration `0011_jira_backfill.sql`:** Jira facts on `tickets` (type, status, status category,
  reporter, assignee, `archived_at` — none in the content hash); `import_window_days` (180) and
  `analyze_window_days` (30) on `projects`; the `sync_jobs` queue with leases and a dedupe index.
- **Code:** `packages/ingest/src/adf.ts` (ADF → text, AC section split),
  `packages/ingest/src/jira/issues.ts` (`/search/jql` paging, normalize). The worker is
  `packages/sync` + `scripts/worker.ts` (`npm run worker`), not `apps/worker`: it lives with
  `ops.ts`, and its logic is testable under the root vitest config.
- **Money guards (all tested):** import never analyzes; analysis is admin-started per batch with
  the estimate shown first; batch ≤ `ANALYZE_BATCH_LIMIT` (50) tickets and ≤
  `ANALYZE_BATCH_MAX_USD` ($1); tenant token cap checked before every ticket (now also in
  `ops seed --analyze`, which previously skipped it); unpriced models refused; an analyzed
  version is never billed twice; a version that failed twice leaves the candidate list;
  batches are never retried automatically (`max_attempts = 1`, also for lapsed leases).
- **Not yet:** the import window and analysis scope are fixed defaults with no settings UI;
  `JiraSource` as a `TicketSource` class was not needed (the backfill pages directly).

### As built — Milestones C, D, E and Phase 3

- **C. Live sync (`0012`):** one webhook per tenant (OAuth apps get only 5 per site), JQL
  `project IN (...)`, re-registered when the project list changes and refreshed before its
  30-day expiry. Receiver `/api/jira/webhook/[connectionId]` verifies the HS256 JWT signed with
  the client secret, drops retries by `X-Atlassian-Webhook-Identifier`, and only queues a
  re-read. Reconcile polls every 2 min without a public HTTPS URL (localhost), every 15 min
  with one. Deleted or moved issues are archived. Live sync never analyzes.
- **D. Write-back (`0013`):** "Enable write-back" is a separate consent (`?grant=write`, must be
  the same site). Sign-off writes one ADF comment (acceptance criteria + accepted/edited
  clarifications with the PM's answers) and the `specfix-ready` label; each is claimed per
  (version, kind) so it is written once; failures show "Retry Jira update". A test fails if any
  worker module imports the write path.
- **E. Notifications (`0014`):** inbox at `/inbox`; `flags_ready`, `flags_stale`, `signed_off`,
  `ci_failed`. Gmail SMTP via nodemailer 10.2.1 (pinned; earlier versions have open
  advisories), at most one instant email per ticket per hour, daily digest at
  `DIGEST_HOUR_UTC`. Recipients: owners/admins for decisions, everyone for sign-off, until
  per-ticket owners exist.
- **Phase 3. CI results (`0015`):** scaffolds now carry `{ tag: "@sf-<scenario id>" }`. CI posts
  the Playwright JSON report to `/api/ci/results` with a per-project token (SHA-256 stored,
  shown once). Results land only on the token project's scenarios; the Specs tab shows each
  scenario's latest status; failures notify.

New environment: `PUBLIC_BASE_URL` (public HTTPS origin; enables webhooks and email links),
`JIRA_RECONCILE_MINUTES`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`,
`MAIL_ENABLED`, `DIGEST_HOUR_UTC`.

Tests follow the repo's existing pattern (vitest). Jira responses are recorded fixtures under
`fixtures/jira/` (issues with ADF descriptions, AC custom field, deleted/moved issues, webhook
bodies) — no live Jira calls in CI.

---

## 7. Open decisions

- ~~O1 — Jira-side status presence~~ → **settled: strict §9** (see D4).
- ~~O2 — Email provider~~ → **settled: Gmail SMTP via Nodemailer** (see §5, Notifications).
- **O3 — Where the worker runs.** Same Railway/Fly project as the web app, as a second service.
- **O4 — Atlassian developer app.** To be created by the team at developer.atlassian.com
  (OAuth 2.0 integration) — setup in §9. Owned by a team account, not a personal one.

## 9. Atlassian developer app setup (done by a human, once)

1. developer.atlassian.com → *Developer console* → *Create* → **OAuth 2.0 integration**. Name: `SpecFix`.
2. *Permissions* → **Jira API** → *Add* → *Configure*, add scopes:
   `read:jira-work`, `read:jira-user`, `manage:jira-webhook`, `write:jira-work`.
   (Every scope the app may *ever* request must be listed here. The connect flow still requests
   only the read set; `write:jira-work` is requested later by the write-back consent, D3.
   `offline_access` is not added here — it is requested in the authorize URL.)
3. *Authorization* → OAuth 2.0 (3LO) → callback URL: `http://localhost:3000/api/jira/callback`
   (add staging/prod callbacks when those exist).
4. *Settings* → copy **Client ID** and **Secret** into `.env` (never commit):
   ```
   JIRA_CLIENT_ID=
   JIRA_CLIENT_SECRET=
   JIRA_REDIRECT_URI=http://localhost:3000/api/jira/callback
   TOKEN_ENCRYPTION_KEY=    # 32 random bytes, base64: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
                            # encrypts stored tokens and (via HKDF) signs the OAuth state
   ```
5. A new app is **private**: only Jira sites the app owner administers can connect. Before any
   other company connects, set *Distribution* → *Sharing* (requires vendor name, privacy policy
   URL and a personal-data declaration).

## 10. GitHub App (built after Phase 3)

The GitHub side of the loop — PR ↔ ticket links by Jira key, the "SpecFix acceptance" check
run, the one "not ready" PR comment, "Open PR with scaffolds", and default-branch-only CI
status — is set up and described in [`docs/github-app.md`](docs/github-app.md) (registration
steps, permissions, env names, what still needs a real app to verify). Schema: migration
`0016_github_app.sql`.

## 8. Explicitly out of scope here

Roles beyond owner/admin/reviewer and Login-with-Atlassian (gap #5), sprint readiness view,
comments/mentions, a Jira workflow "ready gate", Forge app, CI test-result loop. Each is its
own plan once this lands.
