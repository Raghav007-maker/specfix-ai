-- ---------------------------------------------------------------------------
-- 0016 — Workspace plan (pricing, Step 1)
--
-- A workspace is on Pro while pro_until is in the future, and on Free otherwise. Free
-- allows five projects and no resolution agent; the limit is enforced in
-- packages/db (repositories/plans.ts), not here, because SpecFix's own team is exempt.
--
-- Every existing workspace starts on Free (pro_until null). Pro is granted for now with
-- `npm run ops -- plan`; payments set it in a later step.
-- ---------------------------------------------------------------------------

begin;

alter table tenants add column pro_until timestamptz;

commit;
