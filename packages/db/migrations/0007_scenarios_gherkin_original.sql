-- ---------------------------------------------------------------------------
-- 0007 — scenarios: keep the compiler's original Gherkin
--
-- An `edited` decision overwrites scenarios.gherkin_raw with the reviewer's text,
-- and decideScenario documented that a reopen "clears it back to the compiler's
-- original". Nothing stored the original, so a reopen kept the edited text: the
-- Specs tab then showed a reviewer's rewrite as an undecided model draft.
--
-- gherkin_original is written once, at insert, and never updated. A reopen copies
-- it back into gherkin_raw.
--
-- Backfill: a scenario never edited still holds its original in gherkin_raw, so
-- it is copied. A scenario that was edited has already lost its original; it stays
-- NULL rather than recording the reviewer's words as the model's, and a reopen of
-- it keeps the current text, as before. Nullable for exactly that reason.
-- ---------------------------------------------------------------------------

begin;

alter table scenarios add column gherkin_original text;

update scenarios s
set gherkin_original = s.gherkin_raw
where not exists (
  select 1
  from scenario_reviews r
  where r.scenario_id = s.id and r.tenant_id = s.tenant_id and r.decision = 'edited'
);

commit;
