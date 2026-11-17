import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  BOARD_SORTS,
  WORK_TYPE_LABELS,
  applyBoardQuery,
  getProjectDetail,
  listMembers,
  listProjects,
  listWorkItems,
  parseBoardQuery,
  taskKeyOf,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { Card, EmptyNote, Notice } from '@/components/ui';
import {
  NotMigrated,
  PriorityPill,
  ProjectHeader,
  StatusPill,
  TaskFilters,
  epicsOf,
  isFiltered,
} from '../../work-ui';

/** Every task of a project as one table, with the same filters as the board and backlog. */
export default async function ProjectListPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, search, user] = await Promise.all([params, searchParams, requireUser()]);
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
      projectView="list"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="List"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="list"
        canManage={tenant.role !== 'reviewer'}
      />
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);

  const [project, tasks, members] = await Promise.all([
    getProjectDetail(t, projectId),
    listWorkItems(t, projectId),
    listMembers(t),
  ]);
  if (!project) notFound();

  // A list has no column order, so its default is newest first.
  const parsed = parseBoardQuery(search);
  const query = { ...parsed, sort: parsed.sort === 'rank' ? ('created' as const) : parsed.sort };
  const filtered = isFiltered(query, 'created');
  const shown = applyBoardQuery(tasks, query, { userId: user.id, taskKey: project.task_key });
  const labels = [...new Set(tasks.flatMap((task) => task.labels))].sort((a, b) =>
    a.localeCompare(b)
  );
  const keyOf = (n: number) => taskKeyOf(project.task_key, n);
  const one = (k: string) => {
    const v = search[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const error = one('error');
  const notice = one('notice');
  const th = 'px-4 py-2 font-medium';
  const td = 'px-4 py-2.5';

  return shell(
    <>
      {error ? (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" className="mb-4">
          {notice}
        </Notice>
      ) : null}

      <TaskFilters
        action={`/projects/${projectId}/list`}
        query={query}
        members={members}
        labels={labels}
        epics={epicsOf(tasks)}
        taskKey={project.task_key}
        sorts={BOARD_SORTS.filter((v) => v !== 'rank')}
        filtered={filtered}
      />
      <p className="mb-3 text-sm text-muted-foreground">
        {filtered
          ? `Showing ${shown.length} of ${tasks.length} tasks.`
          : `${tasks.length} task${tasks.length === 1 ? '' : 's'}.`}
      </p>

      {tasks.length === 0 ? (
        <EmptyNote>
          No tasks in this project yet.{' '}
          <Link
            href={`/projects/${projectId}/tasks/new`}
            className="underline underline-offset-[3px]"
          >
            Create the first one
          </Link>
          .
        </EmptyNote>
      ) : shown.length === 0 ? (
        <EmptyNote>No tasks match these filters.</EmptyNote>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th scope="col" className={th}>
                  Key
                </th>
                <th scope="col" className={th}>
                  Title
                </th>
                <th scope="col" className={th}>
                  Type
                </th>
                <th scope="col" className={th}>
                  Status
                </th>
                <th scope="col" className={th}>
                  Priority
                </th>
                <th scope="col" className={th}>
                  Assignee
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Points
                </th>
                <th scope="col" className={th}>
                  Sprint
                </th>
                <th scope="col" className={th}>
                  Due
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {shown.map((task) => (
                <tr key={task.id} className="hover:bg-raised/60">
                  <td className={`${td} whitespace-nowrap font-mono text-[13px]`}>
                    <Link
                      href={`/projects/${projectId}/tasks/${task.number}`}
                      className="rounded-sm underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                    >
                      {keyOf(task.number)}
                    </Link>
                  </td>
                  <td className={`${td} max-w-[22rem]`}>
                    <span className="block truncate">{task.title}</span>
                    {task.parent_number !== null ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        <span className="font-mono">{keyOf(task.parent_number)}</span>{' '}
                        {task.parent_title}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{WORK_TYPE_LABELS[task.type]}</td>
                  <td className={td}>
                    <StatusPill status={task.status} />
                  </td>
                  <td className={td}>
                    <PriorityPill priority={task.priority} />
                  </td>
                  <td className={`${td} max-w-[12rem] truncate text-muted-foreground`}>
                    {task.assignee_email ?? 'Unassigned'}
                  </td>
                  <td className={`${td} text-right tabular-nums text-muted-foreground`}>
                    {task.story_points ?? '—'}
                  </td>
                  <td className={`${td} max-w-[9rem] truncate text-muted-foreground`}>
                    {task.sprint_name ?? 'Backlog'}
                  </td>
                  <td
                    className={`${td} whitespace-nowrap tabular-nums ${task.overdue ? 'text-negative' : 'text-muted-foreground'}`}
                  >
                    {task.due_on ?? '—'}
                    {task.overdue ? <span className="sr-only"> (overdue)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
