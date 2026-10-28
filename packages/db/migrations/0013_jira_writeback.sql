-- ---------------------------------------------------------------------------
-- 0013 — Jira write-back at sign-off (Jira integration plan, Milestone D)
--
-- jira_writebacks records every write SpecFix makes to a Jira issue: one row per
-- (ticket version, kind). The unique key makes sign-off idempotent — a double click, a
-- retry after a timeout, or marking the same version ready twice writes to Jira once.
-- A failed row can be retried; a done row is never written again.
--
-- The write grant itself is a jira_connections row with grant_kind 'write' (0010), a
-- separate consent from the read grant, used by exactly one code path: PM sign-off.
-- ---------------------------------------------------------------------------

begin;

create table jira_writebacks (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  kind               text        not null check (kind in ('comment', 'label')),
  -- The Jira comment id, or the label added.
  jira_ref           text,
  status             text        not null default 'pending'
                       check (status in ('pending', 'done', 'failed')),
  error              text,
  requested_by       uuid        not null references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, ticket_version_id, kind)
);

create index jira_writebacks_ticket on jira_writebacks (tenant_id, ticket_id, created_at desc);

alter table jira_writebacks enable row level security;

create policy jira_writebacks_tenant_read on jira_writebacks
  for select using (specfix_member_of(tenant_id));

commit;
