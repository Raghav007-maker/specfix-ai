-- ---------------------------------------------------------------------------
-- 0015 — CI test results (Phase 3)
--
-- Closes the loop from approved scenario to running code: a team's CI posts its
-- Playwright JSON report to /api/ci/results, and each scenario shows whether its test
-- passed on the latest commit.
--
--   ci_tokens   one per project, sent by CI as a bearer token. Only a SHA-256 hash is
--               stored; the token itself is shown once when created. Revoked tokens
--               stay for the audit trail.
--   ci_runs     one per report received: commit, branch, link to the CI run, counts.
--   ci_results  one per (run, scenario). Scenario ids come from the `@sf-<id>` tag the
--               scaffold emits and are accepted only for scenarios of the token's project.
-- ---------------------------------------------------------------------------

begin;

create table ci_tokens (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  project_id    uuid        not null references projects (id) on delete cascade,
  token_hash    text        not null unique,
  -- The first characters, so a person can tell tokens apart without the secret.
  token_prefix  text        not null,
  created_by    uuid        references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- At most one live token per project.
create unique index ci_tokens_one_live on ci_tokens (tenant_id, project_id) where revoked_at is null;

create table ci_runs (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete cascade,
  project_id   uuid        not null references projects (id) on delete cascade,
  commit_sha   text,
  branch       text,
  run_url      text,
  total        integer     not null default 0,
  passed       integer     not null default 0,
  failed       integer     not null default 0,
  flaky        integer     not null default 0,
  skipped      integer     not null default 0,
  unmatched    integer     not null default 0,
  received_at  timestamptz not null default now()
);

create index ci_runs_project on ci_runs (tenant_id, project_id, received_at desc);

create table ci_results (
  tenant_id    uuid        not null references tenants (id) on delete cascade,
  ci_run_id    uuid        not null references ci_runs (id) on delete cascade,
  scenario_id  uuid        not null references scenarios (id) on delete cascade,
  status       text        not null check (status in ('passed', 'failed', 'flaky', 'skipped')),
  duration_ms  integer     not null default 0,
  error        text,
  primary key (ci_run_id, scenario_id)
);

create index ci_results_scenario on ci_results (tenant_id, scenario_id);

alter table ci_tokens  enable row level security;
alter table ci_runs    enable row level security;
alter table ci_results enable row level security;

create policy ci_runs_tenant_read on ci_runs for select using (specfix_member_of(tenant_id));
create policy ci_results_tenant_read on ci_results for select using (specfix_member_of(tenant_id));

commit;
