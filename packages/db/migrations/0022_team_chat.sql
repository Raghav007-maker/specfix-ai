-- ---------------------------------------------------------------------------
-- 0022 — Team conversation per project, and @mentions
--
--   project_messages   one conversation per project: every member of the workspace can
--                      read and post. Messages are append-only from the app (an author may
--                      not edit); a deleted project takes its conversation with it.
--   notifications      + kind 'mentioned': someone wrote @you in a project conversation or
--                      a task comment. Its email goes out like the task kinds. The message
--                      is identified in `payload` (projectId, and taskId/number for a task).
-- ---------------------------------------------------------------------------

begin;

create table project_messages (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  project_id  uuid        not null references projects (id) on delete cascade,
  author_id   uuid        references auth.users (id) on delete set null,
  body        text        not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);

create index project_messages_project_idx
  on project_messages (tenant_id, project_id, created_at desc);

alter table project_messages enable row level security;
create policy project_messages_tenant_all on project_messages for all
  using (specfix_member_of(tenant_id))
  with check (specfix_member_of(tenant_id));

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'flags_ready', 'flags_stale', 'signed_off', 'ci_failed', 'task_assigned', 'task_commented',
  'mentioned'
));

commit;
