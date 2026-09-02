-- SpecFix Phase 1 initial schema.
--
-- Two decisions in here are hard to retrofit and are therefore made now:
--
--  1. tenant_id on every tenant-scoped table, with RLS enabled from the first
--     migration. Note carefully: the BullMQ worker connects with the Supabase
--     service-role key, which BYPASSES RLS. So RLS is defense-in-depth for
--     user-JWT access paths only. Actual isolation is enforced by the repository
--     layer in packages/db/src/repositories, where tenant_id is a required
--     argument, and by the cross-tenant test in packages/db/test.
--
--  2. ticket_versions. A ticket can be edited after its flags were resolved.
--     Flags belong to a version, not to a ticket, so resolved work is never
--     silently attached to text that has since changed.
--
-- Identity lives in Supabase's auth.users. For local Postgres and CI,
-- packages/db/test/auth-shim.sql creates a minimal stand-in.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

create table tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text        not null,
  -- Cost ceiling per calendar month. Enforced in packages/core before a call is
  -- made, not after the bill arrives.
  monthly_token_cap     bigint      not null default 5000000,
  created_at            timestamptz not null default now()
);

create table memberships (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  role        text        not null default 'reviewer'
                            check (role in ('owner', 'admin', 'reviewer')),
  created_at  timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

create index memberships_tenant_idx on memberships (tenant_id);

-- ---------------------------------------------------------------------------
-- Projects and tickets
-- ---------------------------------------------------------------------------

create table projects (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants (id) on delete cascade,
  name              text        not null,
  source_type       text        not null check (source_type in ('file', 'jira')),
  -- Jira Cloud identifiers. Null for file-sourced projects.
  jira_cloud_id     text,
  jira_project_key  text,
  created_at        timestamptz not null default now(),
  constraint projects_jira_fields_present
    check (source_type <> 'jira' or (jira_cloud_id is not null and jira_project_key is not null))
);

create index projects_tenant_idx on projects (tenant_id);

create table tickets (
  id                        uuid        primary key default gen_random_uuid(),
  tenant_id                 uuid        not null references tenants (id) on delete cascade,
  project_id                uuid        not null references projects (id) on delete cascade,
  external_id               text        not null,
  external_key              text        not null,
  title                     text        not null,
  description_text          text        not null default '',
  -- Jira ADF JSON, or the original file payload. Kept so text extraction can be
  -- re-run without re-fetching from the source.
  description_raw           jsonb,
  acceptance_criteria_text  text        not null default '',
  content_hash              text        not null,
  source_updated_at         timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (tenant_id, project_id, external_id)
);

create index tickets_tenant_project_idx on tickets (tenant_id, project_id);

-- One row per distinct analyzable content_hash of a ticket.
create table ticket_versions (
  id                        uuid        primary key default gen_random_uuid(),
  tenant_id                 uuid        not null references tenants (id) on delete cascade,
  ticket_id                 uuid        not null references tickets (id) on delete cascade,
  content_hash              text        not null,
  title                     text        not null,
  description_text          text        not null,
  acceptance_criteria_text  text        not null,
  captured_at               timestamptz not null default now(),
  unique (tenant_id, ticket_id, content_hash)
);

create index ticket_versions_ticket_idx on ticket_versions (tenant_id, ticket_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Analysis
-- ---------------------------------------------------------------------------

create table analysis_runs (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  -- Semver plus content hash of the prompt file, e.g. "single-shot-v1@a3f19c2b4d05".
  prompt_version     text        not null,
  model              text        not null,
  temperature        numeric(3, 2) not null,
  seed               integer,
  status             text        not null default 'queued'
                       check (status in ('queued', 'running', 'succeeded', 'failed')),
  -- True when ticket text exceeded MAX_TICKET_INPUT_TOKENS and was cut. Any
  -- metric computed over truncated runs has to say so.
  truncated          boolean     not null default false,
  input_tokens       integer     not null default 0,
  output_tokens      integer     not null default 0,
  cost_usd           numeric(12, 6) not null default 0,
  error              text,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index analysis_runs_ticket_idx on analysis_runs (tenant_id, ticket_id, created_at desc);
create index analysis_runs_version_idx on analysis_runs (tenant_id, ticket_version_id);

create table flags (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  analysis_run_id    uuid        not null references analysis_runs (id) on delete cascade,
  category           text        not null check (category in (
                       'missing_info', 'vague_language', 'contradiction',
                       'edge_case', 'security_compliance', 'untestable')),
  quoted_span        text        not null default '',
  what_unclear       text        not null,
  why_it_matters     text        not null,
  question_for_pm    text        not null,
  severity           text        not null check (severity in ('low', 'medium', 'high')),
  status             text        not null default 'open'
                       check (status in ('open', 'accepted', 'edited', 'dismissed', 'stale')),
  -- Reviewer's rewrite of question_for_pm when status = 'edited'.
  edited_question    text,
  dedupe_key         text        not null,
  created_at         timestamptz not null default now(),
  -- Collapses identical repeats from one model response, per ticket version.
  unique (tenant_id, ticket_version_id, dedupe_key)
);

create index flags_ticket_status_idx on flags (tenant_id, ticket_id, status);
create index flags_run_idx on flags (tenant_id, analysis_run_id);

-- Append-only. Never updated, never deleted: this is the audit trail.
create table flag_decisions (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  flag_id          uuid        not null references flags (id) on delete cascade,
  user_id          uuid        not null references auth.users (id),
  decision         text        not null
                     check (decision in ('accepted', 'edited', 'dismissed', 'reopened')),
  edited_text      text,
  resolution_note  text,
  created_at       timestamptz not null default now()
);

create index flag_decisions_flag_idx on flag_decisions (tenant_id, flag_id, created_at);

-- ---------------------------------------------------------------------------
-- Measurement
-- ---------------------------------------------------------------------------

-- Enforces the blind-first labeling order that makes recall measurable.
--
-- Model flags must not be sent to the client before gaps_locked_at is set. If a
-- reviewer sees the model's flags first, their own gap list is anchored to it and
-- the recall denominator is worthless. The server checks this column; it is not a
-- UI convention.
create table labeling_sessions (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  reviewer_id        uuid        not null references auth.users (id),
  stage              text        not null default 'blind_gaps'
                       check (stage in ('blind_gaps', 'reveal', 'link', 'done')),
  started_at         timestamptz not null default now(),
  gaps_locked_at     timestamptz,
  revealed_at        timestamptz,
  completed_at       timestamptz,
  -- One reviewer labels a given version once. A second reviewer gets their own
  -- row; that overlap is what the inter-rater agreement check reads.
  unique (tenant_id, ticket_version_id, reviewer_id)
);

create index labeling_sessions_version_idx on labeling_sessions (tenant_id, ticket_version_id);

-- The reviewer's own list of gaps, written before model flags are revealed.
-- This table is the recall denominator.
create table reviewer_gaps (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references tenants (id) on delete cascade,
  labeling_session_id   uuid        not null references labeling_sessions (id) on delete cascade,
  ticket_version_id     uuid        not null references ticket_versions (id) on delete cascade,
  reviewer_id           uuid        not null references auth.users (id),
  description           text        not null,
  -- Set during the link stage when a model flag covers this gap. Null = a miss.
  matched_flag_id       uuid        references flags (id) on delete set null,
  matched_at            timestamptz,
  created_at            timestamptz not null default now()
);

create index reviewer_gaps_session_idx on reviewer_gaps (tenant_id, labeling_session_id);
create index reviewer_gaps_version_idx on reviewer_gaps (tenant_id, ticket_version_id);

-- Every model call. This is the eval substrate the plan calls for: prompt
-- version in, output out, cost attached.
create table llm_calls (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants (id) on delete cascade,
  analysis_run_id   uuid        references analysis_runs (id) on delete cascade,
  purpose           text        not null check (purpose in ('extract', 'judge', 'single_shot')),
  prompt_version    text        not null,
  model             text        not null,
  request           jsonb       not null,
  response          jsonb,
  latency_ms        integer,
  input_tokens      integer     not null default 0,
  output_tokens     integer     not null default 0,
  cost_usd          numeric(12, 6) not null default 0,
  error             text,
  created_at        timestamptz not null default now()
);

create index llm_calls_run_idx on llm_calls (tenant_id, analysis_run_id);
create index llm_calls_month_idx on llm_calls (tenant_id, created_at);

-- Time-to-ready. Jira changelog history backfills the "before tool" baseline.
create table readiness_events (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        references ticket_versions (id) on delete set null,
  event              text        not null check (event in (
                       'ticket_ingested', 'analysis_complete',
                       'all_flags_resolved', 'marked_ready')),
  -- Null for system-generated events.
  user_id            uuid        references auth.users (id),
  -- True for rows backfilled from Jira changelog history rather than observed live.
  backfilled         boolean     not null default false,
  occurred_at        timestamptz not null default now()
);

create index readiness_events_ticket_idx on readiness_events (tenant_id, ticket_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Defense-in-depth for user-JWT paths. Not the isolation mechanism — see the
-- header comment.
-- ---------------------------------------------------------------------------

alter table tenants            enable row level security;
alter table memberships        enable row level security;
alter table projects           enable row level security;
alter table tickets            enable row level security;
alter table ticket_versions    enable row level security;
alter table analysis_runs      enable row level security;
alter table flags              enable row level security;
alter table flag_decisions     enable row level security;
alter table labeling_sessions  enable row level security;
alter table reviewer_gaps      enable row level security;
alter table llm_calls          enable row level security;
alter table readiness_events   enable row level security;

create or replace function specfix_member_of(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.tenant_id = target_tenant
      and m.user_id = auth.uid()
  );
$$;

create policy tenants_member_read on tenants
  for select using (specfix_member_of(id));

create policy memberships_self_read on memberships
  for select using (user_id = auth.uid());

do $$
declare
  t text;
begin
  foreach t in array array[
    'projects', 'tickets', 'ticket_versions', 'analysis_runs', 'flags',
    'flag_decisions', 'labeling_sessions', 'reviewer_gaps', 'llm_calls',
    'readiness_events'
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
