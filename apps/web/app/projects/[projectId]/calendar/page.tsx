import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  getProjectDetail,
  listProjects,
  listWorkItems,
  parseMonth,
  shiftMonth,
  taskKeyOf,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { CalendarGrid, NotMigrated, ProjectHeader } from '../../work-ui';

/**
 * A project's tasks on a month calendar by due date, coloured red / yellow / green by
 * urgency. "+" on a day creates a task due that day; tasks without a due date are counted
 * under the calendar so nothing is silently missing.
 */
export default async function ProjectCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const [{ projectId }, { month: monthParam }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t, user.id), workTablesAvailable()]);
  const sidebarProject = projects.find((p) => p.id === projectId);
  if (!sidebarProject) notFound();

  const shell = (children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      projectView="calendar"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Calendar"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="calendar"
        canManage={sidebarProject.role !== 'reviewer'}
      />
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);

  const [project, tasks] = await Promise.all([
    getProjectDetail(t, projectId),
    listWorkItems(t, projectId),
  ]);
  if (!project) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const month = parseMonth(monthParam, today);
  const base = `/projects/${projectId}/calendar`;
  const undated = tasks.filter((task) => !task.due_on && task.status !== 'done').length;

  return shell(
    <div className="space-y-4">
      <CalendarGrid
        label={`${project.name} calendar`}
        month={month}
        today={today}
        tasks={tasks}
        keyOf={(_, n) => taskKeyOf(project.task_key, n)}
        prevHref={`${base}?month=${shiftMonth(month, -1)}`}
        nextHref={`${base}?month=${shiftMonth(month, 1)}`}
        todayHref={base}
        addHref={(day) => `/projects/${projectId}/tasks/new?due=${day}`}
      />
      {undated > 0 ? (
        <p className="text-sm text-muted-foreground">
          {undated} unfinished task{undated === 1 ? ' has' : 's have'} no due date, so{' '}
          {undated === 1 ? 'it is' : 'they are'} not on the calendar. Set one on the task, or find{' '}
          {undated === 1 ? 'it' : 'them'} on List.
        </p>
      ) : null}
    </div>
  );
}
