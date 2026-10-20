-- ---------------------------------------------------------------------------
-- 0004 — Embedding write path
--
-- 0003 created requirement_embeddings and scenario_embeddings as a schema
-- decision, with a comment saying they would be populated in Milestone D and
-- nothing else. This migration makes them usable:
--
--   1. 'embed' joins the llm_calls purpose set, so embedding spend is separable
--      from the chat passes in the cost breakdown rather than landing in
--      single_shot.
--   2. Approximate-nearest-neighbour indexes, so the fuzzy-coverage and drift
--      queries are not sequential scans.
--
-- Index choice: HNSW, not IVFFlat. IVFFlat needs a populated table to build
-- useful lists (it trains on the data present at creation), which makes it a
-- migration that has to be re-run after the first backfill — a footgun for a
-- table that is empty at migrate time. HNSW builds incrementally, so the index
-- is correct from the first insert and needs no rebuild. It costs more to build
-- and more memory; at this table's size that is not the binding constraint.
--
-- `vector_cosine_ops` matches the search the application performs. The vectors
-- are unit-normalized, so cosine and inner product rank identically — cosine is
-- named explicitly so the operator would still be right if a future model
-- returned unnormalized vectors.
-- ---------------------------------------------------------------------------

begin;

alter table llm_calls drop constraint llm_calls_purpose_check;
alter table llm_calls add constraint llm_calls_purpose_check
  check (purpose in ('extract', 'critic', 'judge', 'single_shot', 'compile_gherkin', 'embed'));

-- An embedding call is not attached to an analysis run or a compile run: it is its
-- own pass, sometimes a backfill sweep across many tickets. Both existing FKs are
-- therefore null for it, which required no new column — the CHECK added in 0003
-- only forbids having both set at once.

-- ---------------------------------------------------------------------------
-- Vector indexes
-- ---------------------------------------------------------------------------

-- requirement_embeddings is keyed by ticket_version_id, and the coverage query
-- compares every requirement on one version against the version's scenarios, so
-- the useful access path is "vectors for this tenant, near this vector".
create index requirement_embeddings_hnsw_idx
  on requirement_embeddings using hnsw (embedding vector_cosine_ops);

-- Every embedding read is tenant-scoped. RLS is defense-in-depth for user-JWT
-- paths only (the worker holds the service-role key and bypasses it), so the
-- tenant predicate is carried by the query and served by this index.
create index requirement_embeddings_tenant_idx on requirement_embeddings (tenant_id);

create index scenario_embeddings_hnsw_idx
  on scenario_embeddings using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Staleness, read-side
--
-- requirement_embeddings.content holds the text the vector was built from, so a
-- row whose content no longer matches the version's current text is detectable
-- without a second table — this is what 0003's comment promised. The comparison
-- itself happens in SQL against ticket_versions; no column is needed for it.
--
-- scenario_embeddings has no equivalent: a scenario's gherkin_raw is replaced in
-- place when a reviewer edits it, so the embedding is refreshed as part of that
-- write rather than detected afterwards.
-- ---------------------------------------------------------------------------

commit;
