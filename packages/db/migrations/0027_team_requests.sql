-- ---------------------------------------------------------------------------
-- 0027 — Asking to join a team, and asking for a project
--
--   team_join_requests      a signed-in person asks to join a workspace (found by name). The
--                           workspace owner approves (they join as a reviewer, with no project
--                           yet) or rejects. One pending request per person per workspace.
--   project_requests        an admin asks for a new project; the owner approves (the project is
--                           created and the requester becomes its admin) or rejects.
--
-- The owner's decision is made inside one transaction in
-- packages/db/src/repositories/team-requests.ts, so approving twice at once admits the person
-- (or creates the project) exactly once. The app server connects as the database owner, which
-- RLS does not apply to; the policies protect Supabase's API roles.
-- ---------------------------------------------------------------------------

begin;

create table team_join_requests (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  status      text        not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  decided_by  uuid        references auth.users (id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- At most one open request per person and workspace.
create unique index team_join_requests_one_pending
  on team_join_requests (tenant_id, user_id) where status = 'pending';
create index team_join_requests_user_idx on team_join_requests (user_id, created_at desc);

create table project_requests (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  requested_by  uuid        not null references auth.users (id) on delete cascade,
  name          text        not null check (char_length(name) between 1 and 100),
  status        text        not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  project_id    uuid        references projects (id) on delete set null,
  decided_by    uuid        references auth.users (id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index project_requests_tenant_idx on project_requests (tenant_id, status, created_at desc);

alter table team_join_requests enable row level security;
create policy team_join_requests_select on team_join_requests for select
  using (user_id = auth.uid() or specfix_member_of(tenant_id));

alter table project_requests enable row level security;
create policy project_requests_select on project_requests for select
  using (specfix_member_of(tenant_id));

commit;
