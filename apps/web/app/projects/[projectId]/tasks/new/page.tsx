import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  getProjectDetail,
  listLinkableScenarios,
  listLinkableTickets,
  listMembers,
  listProjects,
  listWorkItems,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle, Notice, buttonClasses } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { createTaskAction } from '../../../actions';
import { NotMigrated, TaskFormFields } from '../../../work-ui';

/**
 * Create a task, as Jira's Create dialog. `?ticket=` (from a ticket's Specs tab) preselects a
 * spec ticket, `?parent=` (Add task / Add sub-task on a task page) a parent, either only when
 * it belongs to this project, and `?due=` (a calendar day's "+") a due date.
 */
export default async function NewTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; ticket?: string; parent?: string; due?: string }>;
}) {
  const [{ projectId }, { error, ticket, parent, due }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t), workTablesAvailable()]);
  const sidebarProject = projects.find((p) => p.id === projectId);
  if (!sidebarProject) notFound();

  const shell = (children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Create task"
        />
      }
    >
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);

  const [project, tasks, members, tickets, scenarios] = await Promise.all([
    getProjectDetail(t, projectId),
    listWorkItems(t, projectId),
    listMembers(t),
    listLinkableTickets(t, projectId),
    listLinkableScenarios(t, projectId),
  ]);
  if (!project) notFound();
  const prefillTicket = tickets.find((tk) => tk.id === ticket)?.id;
  const prefillParent = tasks.find((tk) => tk.id === parent && tk.type !== 'subtask');
  // From a calendar day; the form re-validates whatever is submitted.
  const prefillDue = due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined;

  return shell(
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Create task</CardTitle>
          <p className="text-sm text-muted-foreground">
            In {project.name}. Only the title is required.
          </p>
        </CardHeader>
        <CardContent className="pt-5">
          {error ? (
            <Notice tone="error" className="mb-4">
              {error}
            </Notice>
          ) : null}
          <form action={createTaskAction} className="space-y-6">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="from" value="new" />
            <TaskFormFields
              members={members}
              tickets={tickets}
              scenarios={scenarios}
              tasks={tasks}
              taskKey={project.task_key}
              defaultTicketId={prefillTicket}
              defaultParent={prefillParent}
              defaultDueOn={prefillDue}
              idPrefix="new"
            />
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
              <Link href={`/projects/${projectId}`} className={buttonClasses('ghost')}>
                Cancel
              </Link>
              <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
