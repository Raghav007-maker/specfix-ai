-- ---------------------------------------------------------------------------
-- 0006 — One vector per acceptance-criteria clause
--
-- The Phase 2 plan (§4) gives the embedding tables two jobs: fuzzy coverage —
-- "which AC clause has no scenario?" — and drift. requirement_embeddings cannot
-- do the first: it is keyed by ticket_version_id, one vector for the whole AC +
-- description, so it can say how close a scenario is to the requirement as a
-- whole but never which clause a scenario covers or which clause nothing covers.
-- (The same shape is why nearestRequirements, ranking rows within one version,
-- could only ever return one row.)
--
-- This table stores a vector per clause instead, alongside the whole-requirement
-- vector rather than replacing it. Clauses are split by `splitAcClauses` in
-- @specfix/shared — the same function the generation eval uses for its AC
-- coverage metric — and `clause_index` is the clause's position in that split.
--
-- Like the other embedding tables it carries the text it was built from, so a
-- vector that no longer matches its clause is detectable by comparison, and a
-- re-embed replaces a version's clauses as a set (the clause count can change).
--
-- No ANN index: every query is "this version's clauses against this version's
-- accepted scenarios" — tens of rows on each side, scoped by the btree below —
-- so an exact comparison is cheaper than an index the planner would not use.
-- ---------------------------------------------------------------------------

begin;

create table requirement_clause_embeddings (
  ticket_version_id  uuid        not null references ticket_versions (id) on delete cascade,
  clause_index       integer     not null check (clause_index >= 0),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  content            text        not null,
  embedding          vector(1536) not null,
  model              text        not null,
  created_at         timestamptz not null default now(),
  primary key (ticket_version_id, clause_index)
);

create index requirement_clause_embeddings_tenant_idx
  on requirement_clause_embeddings (tenant_id, ticket_version_id);

-- Same posture as 0001 and 0003: defense-in-depth for user-JWT paths. Isolation is
-- the repository layer's tenant predicate.
alter table requirement_clause_embeddings enable row level security;

create policy requirement_clause_embeddings_tenant_all on requirement_clause_embeddings
  for all
  using (specfix_member_of(tenant_id))
  with check (specfix_member_of(tenant_id));

commit;
