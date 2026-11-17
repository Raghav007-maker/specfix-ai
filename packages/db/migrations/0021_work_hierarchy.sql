-- ---------------------------------------------------------------------------
-- 0021 — Task hierarchy and story points
--
--   work_items.parent_id     Epic → Story/Task/Bug → Sub-task. One level per type, so no
--                            cycle can form; the rules (same project, allowed parent
--                            type) are checked by packages/db/src/repositories/work.ts in
--                            the writing transaction. Deleting a parent leaves its children
--                            without one.
--   work_items.story_points  an optional whole-number estimate, 0–100.
--   type 'subtask'           the new lowest level.
--
-- Columns are nullable and the type list only grows, so existing rows and queries are
-- unchanged. work_items already has RLS (0019).
-- ---------------------------------------------------------------------------

begin;

alter table work_items
  add column parent_id    uuid     references work_items (id) on delete set null,
  add column story_points smallint check (story_points between 0 and 100),
  add constraint work_items_parent_not_self check (parent_id <> id);

alter table work_items drop constraint work_items_type_check;
alter table work_items add constraint work_items_type_check
  check (type in ('task', 'bug', 'story', 'epic', 'subtask'));

create index work_items_parent_idx on work_items (tenant_id, parent_id);

commit;
