-- ---------------------------------------------------------------------------
-- 0016 — GitHub App integration
--
-- Connects a workspace's GitHub repositories to SpecFix: pull requests are linked to
-- tickets by the Jira keys in their branch, title or body; CI results on a PR's commit
-- become a "SpecFix acceptance" check run; and approved scaffolds can be opened as a PR.
--
--   github_installations         one GitHub App installation per row, owned by exactly one
--                                workspace (installation_id is globally unique).
--   github_installation_tokens   cached installation access tokens (1 hour lifetime),
--                                AES-256-GCM ciphertext from packages/db/src/crypto.ts.
--                                RLS on and NO policy: no user JWT can read a token row.
--   github_repositories          repositories the installation can reach, each optionally
--                                mapped to one SpecFix project. default_branch decides
--                                which CI runs set a ticket's status.
--   github_pull_requests         PRs seen through webhooks or opened by SpecFix.
--                                warning_comment_id is the one "not ready" comment, which
--                                is edited in place rather than posted again.
--   github_pr_tickets            PR ↔ ticket links, and where the key was found.
--   github_check_runs            one "SpecFix acceptance" check run per (PR, head commit).
--   github_scaffold_prs          the "Open PR with scaffolds" claim per (ticket, repo), so
--                                a double click or a retry reuses the branch and PR.
--   github_webhook_deliveries    X-GitHub-Delivery ids already accepted. Never the body.
--
-- ci_runs learns which repository and PR a run belongs to, and whether it ran on the
-- repository's default branch. Only default-branch runs set a ticket's CI status; a
-- feature-branch run no longer overwrites it (it is shown on its PR instead).
-- ---------------------------------------------------------------------------

begin;

create table github_installations (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references tenants (id) on delete cascade,
  installation_id       bigint      not null unique,
  account_login         text        not null,
  account_type          text        not null,
  repository_selection  text        not null default 'selected',
  installed_by          uuid        references auth.users (id) on delete set null,
  suspended_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index github_installations_tenant on github_installations (tenant_id);

create table github_installation_tokens (
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  installation_id  bigint      primary key
                     references github_installations (installation_id) on delete cascade,
  token_enc        bytea       not null,
  key_id           text        not null,
  expires_at       timestamptz not null,
  updated_at       timestamptz not null default now()
);

create table github_repositories (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  installation_id  bigint      not null
                     references github_installations (installation_id) on delete cascade,
  repo_id          bigint      not null unique,
  full_name        text        not null,
  default_branch   text        not null,
  project_id       uuid        references projects (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index github_repositories_tenant on github_repositories (tenant_id, project_id);

create table github_pull_requests (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants (id) on delete cascade,
  repository_id       uuid        not null references github_repositories (id) on delete cascade,
  number              integer     not null,
  title               text        not null default '',
  head_ref            text        not null,
  head_sha            text        not null,
  base_ref            text        not null,
  state               text        not null check (state in ('open', 'closed', 'merged')),
  html_url            text,
  warning_comment_id  bigint,
  updated_at          timestamptz not null default now(),
  unique (tenant_id, repository_id, number)
);

create index github_pull_requests_head on github_pull_requests (tenant_id, repository_id, head_sha);

create table github_pr_tickets (
  tenant_id        uuid not null references tenants (id) on delete cascade,
  pull_request_id  uuid not null references github_pull_requests (id) on delete cascade,
  ticket_id        uuid not null references tickets (id) on delete cascade,
  source           text not null check (source in ('branch', 'title', 'body', 'specfix')),
  primary key (pull_request_id, ticket_id)
);

create index github_pr_tickets_ticket on github_pr_tickets (tenant_id, ticket_id);

create table github_check_runs (
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  pull_request_id  uuid        not null references github_pull_requests (id) on delete cascade,
  head_sha         text        not null,
  check_run_id     bigint,
  ci_run_id        uuid        references ci_runs (id) on delete set null,
  conclusion       text        check (conclusion in ('success', 'failure', 'neutral')),
  title            text,
  updated_at       timestamptz not null default now(),
  primary key (pull_request_id, head_sha)
);

create table github_scaffold_prs (
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  ticket_id        uuid        not null references tickets (id) on delete cascade,
  repository_id    uuid        not null references github_repositories (id) on delete cascade,
  branch           text        not null,
  pull_request_id  uuid        references github_pull_requests (id) on delete set null,
  opened_by        uuid        references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, ticket_id, repository_id)
);

create table github_webhook_deliveries (
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  delivery_id   text        primary key,
  event         text        not null,
  action        text,
  received_at   timestamptz not null default now()
);

create index github_webhook_deliveries_age on github_webhook_deliveries (received_at);

alter table ci_runs
  add column repository_id      uuid references github_repositories (id) on delete set null,
  add column pull_request_id    uuid references github_pull_requests (id) on delete set null,
  add column on_default_branch  boolean not null default true;

-- Runs recorded before this migration: a named branch other than main/master was a
-- feature-branch run and must not keep setting the ticket's status.
update ci_runs set on_default_branch = false
where branch is not null and branch not in ('main', 'master');

create index ci_runs_pull_request on ci_runs (tenant_id, pull_request_id, received_at desc)
  where pull_request_id is not null;

alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check check (kind in (
  'jira_backfill', 'analyze_batch', 'jira_issue_sync', 'jira_reconcile', 'jira_webhook_sync',
  'notify_deliver', 'notify_digest',
  'github_pr_sync', 'github_check_run', 'github_repo_sync'
));

alter table github_installations        enable row level security;
alter table github_installation_tokens  enable row level security;
alter table github_repositories         enable row level security;
alter table github_pull_requests        enable row level security;
alter table github_pr_tickets           enable row level security;
alter table github_check_runs           enable row level security;
alter table github_scaffold_prs         enable row level security;
alter table github_webhook_deliveries   enable row level security;

create policy github_installations_tenant_read on github_installations
  for select using (specfix_member_of(tenant_id));
create policy github_repositories_tenant_read on github_repositories
  for select using (specfix_member_of(tenant_id));
create policy github_pull_requests_tenant_read on github_pull_requests
  for select using (specfix_member_of(tenant_id));
create policy github_pr_tickets_tenant_read on github_pr_tickets
  for select using (specfix_member_of(tenant_id));
create policy github_check_runs_tenant_read on github_check_runs
  for select using (specfix_member_of(tenant_id));
create policy github_scaffold_prs_tenant_read on github_scaffold_prs
  for select using (specfix_member_of(tenant_id));

commit;
