-- ---------------------------------------------------------------------------
-- 0012 — Jira live sync (Jira integration plan, Milestone C)
--
--   1. jira_webhooks — the tenant's registered Jira webhook. An OAuth app may hold only
--      five webhooks per user per site, so a tenant has ONE, whose JQL covers all its
--      Jira projects; `jql` records what it was registered with, so a changed project
--      list is detected and the webhook re-registered.
--   2. jira_webhook_deliveries — the X-Atlassian-Webhook-Identifier of every delivery
--      accepted, so Jira's retries (up to five) are recognised and dropped. Only the
--      identifier, event and issue id are kept; never the body.
--   3. New job kinds: jira_issue_sync (one issue, from a webhook or reconcile),
--      jira_reconcile (catch what webhooks missed, and the only live path on a server
--      Jira cannot reach), jira_webhook_sync (register / refresh the tenant's webhook).
--   4. sync_jobs.dedupe_key gets a tenant-wide recurring form (`reconcile:<tenant>`), and
--      last_reconciled_at on jira_connections paces the scheduler.
-- ---------------------------------------------------------------------------

begin;

create table jira_webhooks (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  connection_id    uuid        not null references jira_connections (id) on delete cascade,
  jira_webhook_id  bigint      not null,
  jql              text        not null,
  url              text        not null,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  refreshed_at     timestamptz not null default now(),
  unique (tenant_id, connection_id)
);

create table jira_webhook_deliveries (
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  delivery_id   text        not null,
  event         text        not null,
  issue_id      text,
  received_at   timestamptz not null default now(),
  primary key (tenant_id, delivery_id)
);

create index jira_webhook_deliveries_age on jira_webhook_deliveries (received_at);

alter table jira_connections add column last_reconciled_at timestamptz;

alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in (
  'jira_backfill', 'analyze_batch', 'jira_issue_sync', 'jira_reconcile', 'jira_webhook_sync'
));

alter table jira_webhooks enable row level security;
alter table jira_webhook_deliveries enable row level security;

create policy jira_webhooks_tenant_read on jira_webhooks
  for select using (specfix_member_of(tenant_id));

commit;
