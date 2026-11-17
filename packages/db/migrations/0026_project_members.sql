-- ---------------------------------------------------------------------------
-- 0026 — Project-level roles, and time logged on tasks
--
--   project_members   who works on which project, as its admin or a reviewer. A workspace
--                     owner sees every project and needs no row here; everyone else sees
--                     only the projects they have a row for. Removing someone from the
--                     workspace removes them from its projects (the foreign key to
--                     memberships cascades).
--   time_entries      minutes a person spent on a task on a day (1–1440 per entry), with a
--                     short note. Deleting the task deletes its entries.
--
-- Backfill: until now every member saw every project. So that nobody loses access on the
-- day this ships, every existing non-owner member is added to every existing project of
-- their workspace with their workspace role; owners then remove people who should not be
-- there.
--
-- RLS: both tables are readable only by someone who can see the project
-- (specfix_sees_project). The app server connects as the owner, so its own checks in
-- packages/db/src/repositories/project-members.ts are what the app relies on.
-- ---------------------------------------------------------------------------

begin;

create table project_members (
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  project_id  uuid        not null references projects (id) on delete cascade,
  user_id     uuid        not null,
  role        text        not null check (role in ('admin', 'reviewer')),
  added_by    uuid        references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id),
  foreign key (user_id, tenant_id) references memberships (user_id, tenant_id) on delete cascade
);

create index project_members_user_idx on project_members (tenant_id, user_id);

create table time_entries (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  project_id    uuid        not null references projects (id) on delete cascade,
  work_item_id  uuid        not null references work_items (id) on delete cascade,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  minutes       integer     not null check (minutes between 1 and 1440),
  spent_on      date        not null,
  note          text        not null default '' check (char_length(note) <= 200),
  created_at    timestamptz not null default now()
);

create index time_entries_project_idx on time_entries (tenant_id, project_id, user_id);
create index time_entries_item_idx on time_entries (tenant_id, work_item_id, created_at desc);

create or replace function specfix_sees_project(target_tenant uuid, target_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select specfix_member_of(target_tenant) and (
    exists (select 1 from memberships m
            where m.tenant_id = target_tenant and m.user_id = auth.uid() and m.role = 'owner')
    or exists (select 1 from project_members pm
               where pm.tenant_id = target_tenant and pm.project_id = target_project
                 and pm.user_id = auth.uid())
  );
$$;

alter table project_members enable row level security;
create policy project_members_select on project_members for select
  using (specfix_sees_project(tenant_id, project_id));

alter table time_entries enable row level security;
create policy time_entries_select on time_entries for select
  using (specfix_sees_project(tenant_id, project_id));

insert into project_members (tenant_id, project_id, user_id, role)
select p.tenant_id, p.id, m.user_id, m.role
from projects p
join memberships m on m.tenant_id = p.tenant_id
where m.role in ('admin', 'reviewer')
on conflict do nothing;

commit;
