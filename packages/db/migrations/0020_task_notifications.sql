-- ---------------------------------------------------------------------------
-- 0020 — Notifications for project tasks
--
-- The inbox and its emails already cover ticket events. Tasks (0019) add two kinds:
--   task_assigned   to the new assignee
--   task_commented  to the task's assignee and reporter
-- Neither goes to the person who made the change. The task is identified in `payload`
-- (taskId, projectId, number), which also keys the one-email-per-hour rate limit, so no
-- column changes. Overdue tasks are listed in the daily digest and need no row here.
-- ---------------------------------------------------------------------------

begin;

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'flags_ready', 'flags_stale', 'signed_off', 'ci_failed', 'task_assigned', 'task_commented'
));

commit;
