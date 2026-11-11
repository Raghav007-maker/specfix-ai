-- ---------------------------------------------------------------------------
-- 0019 — Project work tracking: tasks, sprints, comments, activity, links
--
-- SpecFix's own tasks, next to (never instead of) the spec tickets. Tickets stay owned
-- by ingest and Jira sync; a task may point at a ticket or a scenario, but nothing here
-- writes to tickets, scenarios or Jira.
--
--   projects           + description, status, and the prefix/counter behind task ids
--                        such as SPX-12. All defaulted, so existing rows and queries are
--                        unchanged; task_key is filled on a project's first task.
--   sprints            per project; at most one active at a time.
--   work_items         the tasks. `number` is per project and never reused.
--   work_item_comments discussion on a task.
--   work_item_events   append-only activity. A task's delete keeps its events (with the
--                        task's number and title copied in) so the project timeline
--                        still shows what was removed.
--   work_item_links    task-to-task links (relates / blocks / duplicates).
--
-- Cross-row tenancy (assignee is a member, ticket and sprint are in the task's project)
-- is checked by packages/db/src/repositories/work.ts inside the writing transaction.
-- ---------------------------------------------------------------------------

begin;

alter table projects
  add column description text    not null default ''
    check (char_length(description) <= 5000),
  add column status      text    not null default 'active'
    check (status in ('active', 'on_hold', 'completed', 'archived')),
  add column task_key    text
    check (task_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  add column task_seq    integer not null default 0;

-- Task ids must not repeat across a workspace's projects.
create unique index projects_task_key_unique on projects (tenant_id, task_key)
  where task_key is not null;

create table sprints (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  project_id    uuid        not null references projects (id) on delete cascade,
  name          text        not null check (char_length(name) between 1 and 100),
  goal          text        not null default '' check (char_length(goal) <= 1000),
  starts_on     date,
  ends_on       date,
  status        text        not null default 'planned'
                  check (status in ('planned', 'active', 'completed')),
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint sprints_dates_ordered check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create index sprints_project_idx on sprints (tenant_id, project_id, created_at);
create unique index sprints_one_active on sprints (tenant_id, project_id) where status = 'active';

create table work_items (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete cascade,
  project_id   uuid        not null references projects (id) on delete cascade,
  number       integer     not null check (number > 0),
  type         text        not null default 'task'
                 check (type in ('task', 'bug', 'story', 'epic')),
  priority     text        not null default 'medium'
                 check (priority in ('low', 'medium', 'high', 'critical')),
  status       text        not null default 'todo'
                 check (status in ('todo', 'in_progress', 'in_review', 'done')),
  title        text        not null check (char_length(title) between 1 and 200),
  description  text        not null default '' check (char_length(description) <= 20000),
  assignee_id  uuid        references auth.users (id) on delete set null,
  reporter_id  uuid        references auth.users (id) on delete set null,
  due_on       date,
  labels       text[]      not null default '{}',
  components   text[]      not null default '{}',
  -- Null is the backlog.
  sprint_id    uuid        references sprints (id) on delete set null,
  -- Order within a board column; lower first.
  rank         double precision not null default 0,
  ticket_id    uuid        references tickets (id) on delete set null,
  scenario_id  uuid        references scenarios (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, project_id, number)
);

create index work_items_project_idx on work_items (tenant_id, project_id, status, rank);
create index work_items_sprint_idx on work_items (tenant_id, sprint_id);
create index work_items_ticket_idx on work_items (tenant_id, ticket_id);
create index work_items_scenario_idx on work_items (tenant_id, scenario_id);

create table work_item_comments (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  work_item_id  uuid        not null references work_items (id) on delete cascade,
  author_id     uuid        references auth.users (id) on delete set null,
  body          text        not null check (char_length(body) between 1 and 10000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index work_item_comments_item_idx on work_item_comments (tenant_id, work_item_id, created_at);

create table work_item_events (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  project_id    uuid        not null references projects (id) on delete cascade,
  work_item_id  uuid        references work_items (id) on delete set null,
  item_number   integer,
  item_title    text,
  actor_id      uuid        references auth.users (id) on delete set null,
  kind          text        not null
                  check (kind in ('created', 'updated', 'deleted', 'commented', 'linked',
                                  'unlinked', 'sprint_created', 'sprint_updated',
                                  'sprint_started', 'sprint_completed')),
  field         text,
  from_value    text,
  to_value      text,
  created_at    timestamptz not null default now()
);

create index work_item_events_project_idx on work_item_events (tenant_id, project_id, created_at desc);
create index work_item_events_item_idx on work_item_events (tenant_id, work_item_id, created_at);

create table work_item_links (
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  from_id     uuid        not null references work_items (id) on delete cascade,
  to_id       uuid        not null references work_items (id) on delete cascade,
  kind        text        not null check (kind in ('relates', 'blocks', 'duplicates')),
  created_by  uuid        references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (from_id, to_id, kind),
  constraint work_item_links_not_self check (from_id <> to_id)
);

create index work_item_links_to_idx on work_item_links (tenant_id, to_id);

alter table sprints            enable row level security;
alter table work_items         enable row level security;
alter table work_item_comments enable row level security;
alter table work_item_events   enable row level security;
alter table work_item_links    enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'sprints', 'work_items', 'work_item_comments', 'work_item_events', 'work_item_links'
  ]
  loop
    execute format(
      'create policy %1$s_tenant_all on %1$s for all
         using (specfix_member_of(tenant_id))
         with check (specfix_member_of(tenant_id))', t
    );
  end loop;
end
$$;

commit;
