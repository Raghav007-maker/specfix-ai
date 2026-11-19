-- ---------------------------------------------------------------------------
-- 0030 — Tasks carry acceptance criteria; spec tickets come from tasks
--
--   work_items.acceptance_criteria   what "done" means, written on the task itself. A task
--                                    sent for spec review becomes a spec ticket (tickets row,
--                                    external_id 'task:<work item id>') whose analysis reads
--                                    the task's description and these criteria.
--
-- Jira is no longer a ticket source. Its tables (jira_connections, jira_webhooks,
-- jira_writebacks, jira_webhook_deliveries) and the Jira columns on projects and tickets stay
-- as they are: nothing writes to them any more, and keeping them makes a rollback a code-only
-- change. The column is not null with a default, so existing rows and queries are unchanged.
-- work_items already has RLS (0019).
-- ---------------------------------------------------------------------------

begin;

alter table work_items
  add column acceptance_criteria text not null default ''
    check (char_length(acceptance_criteria) <= 20000);

commit;
