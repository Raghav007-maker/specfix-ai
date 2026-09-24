-- Deliberation: the Critic pass, and flag provenance.
--
-- Two independent changes that arrived together, both about keeping a measurement
-- honest rather than about new product surface.
--
-- 1. `flags.origin` — precision means "of the gaps the *model* raised, how many
--    were real?" A question a developer typed is real by construction, so counting
--    it in the denominator inflates the number for free, and the inflation grows
--    with adoption. The column exists ahead of the developer-query feature so that
--    feature cannot arrive and quietly redefine precision.
--
-- 2. The Critic's verdict, kept on the flag it judged. Pruned flags are stored,
--    not discarded, for two reasons: the audit log the Critic prompt promises a
--    human will read, and the volume-matched random-pruning control, which needs
--    reviewer verdicts on the flags the Critic threw away in order to show the
--    Critic beat chance.
--
-- No new indexes. The existing (tenant_id, ticket_id, status) and
-- (tenant_id, analysis_run_id) indexes narrow to a handful of rows before any of
-- these columns are filtered on; an index here would be speculative.

begin;

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------

alter table flags
  add column origin text not null default 'ai_agent'
    check (origin in ('ai_agent', 'developer'));

-- ---------------------------------------------------------------------------
-- Critic verdicts
-- ---------------------------------------------------------------------------

alter table flags
  -- Null for a single-shot run, where no Critic pass happened. Null is therefore
  -- meaningful and must not be backfilled to 'keep': it distinguishes "the Critic
  -- approved this" from "no Critic ran".
  add column critic_verdict text
    check (critic_verdict in ('keep', 'prune')),
  add column critic_reason text,
  -- The Extractor's wording before the Critic rewrote it. Null when unchanged.
  -- Without this there is no way to tell whether a refinement helped or hurt.
  add column pre_critic_question text,
  add column pre_critic_severity text
    check (pre_critic_severity in ('low', 'medium', 'high'));

-- A pruned flag is stored but is not open work: it must not appear in a
-- developer's queue, and it is not "dismissed" either, because no human dismissed
-- it. It gets its own terminal status so both facts stay true.
alter table flags drop constraint flags_status_check;
alter table flags add constraint flags_status_check
  check (status in ('open', 'accepted', 'edited', 'dismissed', 'stale', 'pruned'));

-- Status and verdict imply each other, enforced rather than assumed. Letting them
-- drift would produce either a hidden flag with no recorded reason, or a flag shown
-- to a developer that the Critic had rejected.
--
-- `is distinct from` rather than `<>` because critic_verdict is null on every
-- single-shot row, and a null comparison would make the CHECK pass by default —
-- which is precisely the case this is meant to catch.
alter table flags add constraint flags_pruned_matches_verdict
  check (
    case
      when status = 'pruned' then critic_verdict = 'prune'
      else critic_verdict is distinct from 'prune'
    end
  );

-- ---------------------------------------------------------------------------
-- Call log
-- ---------------------------------------------------------------------------

-- 'critic' joins the existing purposes so the two passes are separable in the cost
-- and latency breakdown. Without it the deliberation arm's spend is
-- indistinguishable from the baseline's, which is the comparison the whole
-- experiment rests on.
alter table llm_calls drop constraint llm_calls_purpose_check;
alter table llm_calls add constraint llm_calls_purpose_check
  check (purpose in ('extract', 'critic', 'judge', 'single_shot'));

commit;
