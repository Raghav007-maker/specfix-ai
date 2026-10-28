-- ---------------------------------------------------------------------------
-- 0011 — Jira backfill (Jira integration plan, Milestone B)
--
--   1. tickets learn the Jira facts that decide whether a ticket is worth analyzing
--      (type, status) and who it belongs to (reporter, assignee). None of them is part
--      of the content hash: a status change must not create a version or re-bill an
--      analysis.
--   2. projects carry their two scopes. import_window_days bounds what is copied in;
--      analysis is chosen separately and only ever started by an admin (plan D5).
--   3. sync_jobs — a Postgres job queue drained with FOR UPDATE SKIP LOCKED (plan D1).
--      A running job holds a lease (locked_until); a worker that dies loses it and the
--      job is picked up again, resuming from the checkpoint kept in `payload`.
--      The worker claims jobs across tenants — the one cross-tenant read in the
--      system, done with the service role — and every handler then works inside the
--      job's tenant_id.
-- ---------------------------------------------------------------------------

begin;

alter table tickets
  add column issue_type           text,
  add column status_name          text,
  -- Jira's fixed category: 'new' | 'indeterminate' | 'done'.
  add column status_category      text,
  add column reporter_account_id  text,
  add column assignee_account_id  text,
  -- Set when the issue disappears from the project in Jira (deleted or moved).
  add column archived_at          timestamptz;

alter table projects
  add column import_window_days   integer not null default 180
    check (import_window_days between 1 and 3650),
  add column analyze_window_days  integer not null default 30
    check (analyze_window_days between 1 and 3650);

create table sync_jobs (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  project_id    uuid        references projects (id) on delete cascade,
  kind          text        not null check (kind in ('jira_backfill', 'analyze_batch')),
  payload       jsonb       not null default '{}',
  -- Progress and outcome, for the settings page. Never holds ticket text.
  progress      jsonb       not null default '{}',
  dedupe_key    text,
  status        text        not null default 'queued'
                  check (status in ('queued', 'running', 'done', 'failed')),
  attempts      integer     not null default 0,
  max_attempts  integer     not null default 3,
  run_after     timestamptz not null default now(),
  locked_until  timestamptz,
  last_error    text,
  requested_by  uuid        references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- At most one live job per dedupe key: a second "Import" click is a no-op.
create unique index sync_jobs_dedupe
  on sync_jobs (tenant_id, dedupe_key)
  where status in ('queued', 'running') and dedupe_key is not null;

create index sync_jobs_claim on sync_jobs (run_after) where status in ('queued', 'running');
create index sync_jobs_project on sync_jobs (tenant_id, project_id, created_at desc);

alter table sync_jobs enable row level security;

create policy sync_jobs_tenant_read on sync_jobs
  for select using (specfix_member_of(tenant_id));

commit;
