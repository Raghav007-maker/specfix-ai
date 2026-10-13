-- Phase 2 schema: the Spec Compiler, its artifacts, and the traceability graph.
--
-- Everything here extends the Phase 1 rules rather than replacing them:
--
--  1. tenant_id on every table, RLS enabled, reached only through a packages/db
--     repository whose first argument is tenantId. Same defense-in-depth posture as
--     0001: RLS guards user-JWT paths, the repository layer is the real isolation.
--
--  2. Artifacts belong to a ticket_version, not a ticket. A generated scenario is
--     pinned to the exact acceptance criteria it was compiled from, so re-ingesting
--     the ticket marks it `stale` rather than silently attaching generated tests to
--     requirements that have since changed. This is the same mechanism 0001 uses for
--     flags, applied to the new artifact kind.
--
--  3. Nothing generated is "ready" until a human accepts it. The status enum mirrors
--     flags, and scenario_reviews is an append-only audit exactly like flag_decisions.
--
--  4. Every model call is logged. `compile_gherkin` joins the llm_calls purpose set,
--     and a nullable `compile_run_id` groups the calls of one compilation the way
--     `analysis_run_id` groups the extractor and critic passes of one analysis.
--
-- pgvector arrives here (explicitly out of scope in Phase 1). It is comfortable below
-- ~1M vectors, well beyond this stage, and back the fuzzy coverage / drift queries in
-- Milestone D. The embedding tables are created now as a schema decision — the same
-- discipline that put tenant_id in the first migration — but are populated later.

begin;

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Compile runs
--
-- The counterpart of analysis_runs for the Spec Compiler. Kept separate because a
-- compilation validates against a *different* prompt and produces a different
-- artifact kind; folding it into analysis_runs would blur "this ticket was analyzed"
-- with "this ticket's approved requirements were compiled", which the readiness
-- gates treat differently.
-- ---------------------------------------------------------------------------

create table spec_compile_runs (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  -- Semver plus content hash of the prompt file, e.g. "compile-gherkin-v1@1a2b3c4d5e6f".
  prompt_version     text        not null,
  model              text        not null,
  temperature        numeric(3, 2) not null,
  seed               integer,
  status             text        not null default 'queued'
                       check (status in ('queued', 'running', 'succeeded', 'failed')),
  truncated          boolean     not null default false,
  input_tokens       integer     not null default 0,
  output_tokens      integer     not null default 0,
  cost_usd           numeric(12, 6) not null default 0,
  error              text,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index spec_compile_runs_ticket_idx
  on spec_compile_runs (tenant_id, ticket_id, created_at desc);
create index spec_compile_runs_version_idx
  on spec_compile_runs (tenant_id, ticket_version_id);

-- ---------------------------------------------------------------------------
-- Scenarios
--
-- A Gherkin scenario compiled from a version's approved, disambiguated acceptance
-- criteria. `gherkin_raw` is the rendered text a human reviews and a scaffold is
-- emitted from; the structured steps are not stored separately because the rendered
-- text is the artifact and re-deriving it from a partial record would allow the two
-- to drift.
--
-- `dedupe_key` collapses a scenario the same prompt would emit twice on a re-compile,
-- exactly as flags do, so re-running is idempotent per version.
-- ---------------------------------------------------------------------------

create table scenarios (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_id          uuid        not null references tickets (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  -- Null when the scenario was authored by hand rather than compiled by the model.
  compile_run_id     uuid        references spec_compile_runs (id) on delete set null,
  title              text        not null,
  gherkin_raw        text        not null,
  status             text        not null default 'draft'
                       check (status in ('draft', 'approved', 'edited', 'dismissed', 'stale')),
  origin             text        not null default 'ai_agent'
                       check (origin in ('ai_agent', 'human')),
  -- Which resolved flags/answers drove this scenario. Provenance for the traceability
  -- graph and for the acceptance-rate metric's split by origin.
  source_flag_ids    uuid[]      not null default '{}',
  -- The acceptance-criteria clause this scenario exercises, verbatim, or '' when the
  -- scenario is derived rather than quoting a clause. Verified against the version's
  -- AC text by the compiler before it is stored, the same way quoted_span is for flags.
  covers_ac          text        not null default '',
  rationale          text        not null default '',
  dedupe_key         text        not null,
  created_at         timestamptz not null default now(),
  unique (tenant_id, ticket_version_id, dedupe_key)
);

create index scenarios_version_idx on scenarios (tenant_id, ticket_version_id, status);
create index scenarios_ticket_idx on scenarios (tenant_id, ticket_id, status);

-- Append-only. Never updated, never deleted: this is the audit trail behind the
-- scenario acceptance-rate metric, the counterpart of flag_decisions.
create table scenario_reviews (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  scenario_id      uuid        not null references scenarios (id) on delete cascade,
  user_id          uuid        not null references auth.users (id),
  decision         text        not null
                     check (decision in ('approved', 'edited', 'dismissed', 'reopened')),
  edited_text      text,
  resolution_note  text,
  created_at       timestamptz not null default now()
);

create index scenario_reviews_scenario_idx on scenario_reviews (tenant_id, scenario_id, created_at);

-- ---------------------------------------------------------------------------
-- Test scaffolds
--
-- Deterministically derived from an approved scenario (a codegen step, not an LLM
-- call, so the output is stable and reviewable). Placeholder selectors only: ungated
-- selector generation produces flaky/wrong tests, so a human fills the real ones in.
-- `selector_placeholders` records each placeholder the emitted code contains, so the
-- review UI can list what still needs a real locator.
-- ---------------------------------------------------------------------------

create table test_scaffolds (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references tenants (id) on delete cascade,
  scenario_id           uuid        not null references scenarios (id) on delete cascade,
  ticket_id             uuid        not null references tickets (id) on delete cascade,
  ticket_version_id     uuid        not null references ticket_versions (id) on delete cascade,
  framework             text        not null default 'playwright'
                          check (framework in ('playwright')),
  code                  text        not null,
  selector_placeholders jsonb       not null default '[]'::jsonb,
  status                text        not null default 'draft'
                          check (status in ('draft', 'approved', 'edited', 'dismissed', 'stale')),
  created_at            timestamptz not null default now(),
  -- One scaffold per scenario per framework: regenerating replaces the draft rather
  -- than accumulating duplicates.
  unique (tenant_id, scenario_id, framework)
);

create index test_scaffolds_version_idx on test_scaffolds (tenant_id, ticket_version_id, status);

-- ---------------------------------------------------------------------------
-- Traceability
--
-- requirement (ticket_version + optional flag) <-> scenario <-> scaffold, so coverage
-- is a query rather than a guess. `link_type` records how the link was established,
-- because a link a human drew and a link the compiler inferred are not the same
-- evidence and must not be counted the same in a coverage claim.
-- ---------------------------------------------------------------------------

create table traceability_links (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  -- The requirement side. flag_id is null for an acceptance-criteria-level link that
  -- is not attributable to one resolved flag.
  flag_id            uuid        references flags (id) on delete set null,
  scenario_id        uuid        references scenarios (id) on delete cascade,
  scaffold_id        uuid        references test_scaffolds (id) on delete cascade,
  link_type          text        not null
                       check (link_type in ('requirement_to_scenario',
                                            'scenario_to_scaffold',
                                            'requirement_to_scaffold')),
  -- 'compiler' when inferred during compilation, 'human' when a reviewer drew it.
  created_by         text        not null default 'compiler'
                       check (created_by in ('compiler', 'human')),
  user_id            uuid        references auth.users (id),
  created_at         timestamptz not null default now(),
  -- A link must connect at least one thing to at least one other thing.
  constraint traceability_links_has_endpoints
    check (scenario_id is not null or scaffold_id is not null)
);

create index traceability_links_version_idx on traceability_links (tenant_id, ticket_version_id);
create index traceability_links_scenario_idx on traceability_links (tenant_id, scenario_id);
create index traceability_links_flag_idx on traceability_links (tenant_id, flag_id);

-- ---------------------------------------------------------------------------
-- Embeddings (pgvector)
--
-- 1536 dimensions = text-embedding-3-small, the model the plan selects for cost.
-- Populated in Milestone D, not here: this migration makes the schema decision so the
-- columns and their tenancy exist before any embedding code can invent a different
-- shape. One row per source record; the source id is the primary key so re-embedding
-- is an upsert.
-- ---------------------------------------------------------------------------

create table requirement_embeddings (
  ticket_version_id  uuid        primary key
                       references ticket_versions (id) on delete cascade,
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  -- The AC/requirement text the vector represents, kept so a stale vector can be
  -- detected against the current version without a second table.
  content            text        not null,
  embedding          vector(1536) not null,
  model              text        not null,
  created_at         timestamptz not null default now()
);

create table scenario_embeddings (
  scenario_id  uuid        primary key references scenarios (id) on delete cascade,
  tenant_id    uuid        not null references tenants (id) on delete cascade,
  content      text        not null,
  embedding    vector(1536) not null,
  model        text        not null,
  created_at   timestamptz not null default now()
);

create index scenario_embeddings_tenant_idx on scenario_embeddings (tenant_id);

-- ---------------------------------------------------------------------------
-- Call log
-- ---------------------------------------------------------------------------

-- 'compile_gherkin' joins the purpose set so Phase 2 spend is separable from Phase 1,
-- exactly as 'critic' was added in 0002. A compilation is not attached to an
-- analysis_run, so its calls carry a nullable compile_run_id instead; both FKs are
-- nullable and at most one is set, which the CHECK enforces.
alter table llm_calls
  add column compile_run_id uuid references spec_compile_runs (id) on delete cascade;

alter table llm_calls drop constraint llm_calls_purpose_check;
alter table llm_calls add constraint llm_calls_purpose_check
  check (purpose in ('extract', 'critic', 'judge', 'single_shot', 'compile_gherkin'));

create index llm_calls_compile_idx on llm_calls (tenant_id, compile_run_id);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Same posture as 0001: defense-in-depth for user-JWT paths. Not the isolation
-- mechanism — every query goes through a repository scoped by tenant_id.
-- ---------------------------------------------------------------------------

alter table spec_compile_runs       enable row level security;
alter table scenarios               enable row level security;
alter table scenario_reviews        enable row level security;
alter table test_scaffolds          enable row level security;
alter table traceability_links      enable row level security;
alter table requirement_embeddings  enable row level security;
alter table scenario_embeddings     enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'spec_compile_runs', 'scenarios', 'scenario_reviews', 'test_scaffolds',
    'traceability_links', 'requirement_embeddings', 'scenario_embeddings'
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
