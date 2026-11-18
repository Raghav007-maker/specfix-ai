-- ---------------------------------------------------------------------------
-- 0028 — Asking to join a project
--
--   project_join_requests   a team member asks to join one of the workspace's projects. That
--                           project's admin (or a workspace owner) approves (the person joins as
--                           a reviewer) or rejects. One pending request per person per project.
--
-- Decisions run in one transaction on the locked row in
-- packages/db/src/repositories/team-requests.ts, so approving twice adds the person once.
-- ---------------------------------------------------------------------------

begin;

create table project_join_requests (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  project_id  uuid        not null references projects (id) on delete cascade,
  user_id     uuid        not null,
  status      text        not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  decided_by  uuid        references auth.users (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  -- Leaving the workspace drops the person's requests with their membership.
  foreign key (user_id, tenant_id) references memberships (user_id, tenant_id) on delete cascade
);

create unique index project_join_requests_one_pending
  on project_join_requests (project_id, user_id) where status = 'pending';
create index project_join_requests_tenant_idx
  on project_join_requests (tenant_id, project_id, status);

alter table project_join_requests enable row level security;
create policy project_join_requests_select on project_join_requests for select
  using (user_id = auth.uid() or specfix_sees_project(tenant_id, project_id));

commit;
