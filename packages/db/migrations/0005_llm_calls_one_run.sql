-- ---------------------------------------------------------------------------
-- 0005 — llm_calls: at most one run reference
--
-- 0003 added llm_calls.compile_run_id beside analysis_run_id and described the
-- pair as "both FKs are nullable and at most one is set, which the CHECK
-- enforces". No such CHECK was created — 0003 only replaced the purpose check —
-- and 0004's comment relies on it ("the CHECK added in 0003 only forbids having
-- both set at once"). This migration adds the constraint both comments describe.
--
-- The rule: a call belongs to an analysis run, to a compile run, or to neither (an
-- 'embed' call, which is its own pass). Never to both — a row with both set would
-- be counted in two runs' cost breakdowns.
--
-- Every writer already obeys it: repositories/analysis.ts sets only
-- analysis_run_id, repositories/scenarios.ts only compile_run_id, and
-- recordEmbeddingCalls neither. Existing rows are validated as the constraint is
-- added; if any row violates it the migration fails and, being one transaction,
-- changes nothing — the row is then a data question to settle before re-running.
-- ---------------------------------------------------------------------------

begin;

alter table llm_calls add constraint llm_calls_one_run_check
  check (analysis_run_id is null or compile_run_id is null);

commit;
