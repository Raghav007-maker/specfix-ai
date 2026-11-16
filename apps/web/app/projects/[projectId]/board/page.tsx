import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  BOARD_SORTS,
  WORK_PRIORITY_LABELS,
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  WORK_TYPE_LABELS,
  applyBoardQuery,
  getProjectDetail,
  listMembers,
  listProjects,
  listWorkItems,
  parseBoardQuery,
  taskKeyOf,
  workTablesAvailable,
  type WorkPriority,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { EmptyNote, Notice } from '@/components/ui';
import type { PillTone } from '@/components/ui';
import { NotMigrated, ProjectHeader, TaskFilters, epicsOf, isFiltered } from '../../work-ui';
import { Board, type BoardCard } from './board';

const PRIORITY_TONES: Record<WorkPriority, PillTone> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'warning',
  critical: 'negative',
};

export default async function BoardPage({
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
      projectView="board"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Board"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="board"
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

  const query = parseBoardQuery(search);
  const shown = applyBoardQuery(tasks, query, { userId: user.id, taskKey: project.task_key });
  const labels = [...new Set(tasks.flatMap((task) => task.labels))].sort((a, b) =>
    a.localeCompare(b)
  );
  const filtered = isFiltered(query, 'rank');
  const one = (k: string) => {
    const v = search[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const error = one('error');
  const notice = one('notice');

  const cards: BoardCard[] = shown.map((task) => ({
    id: task.id,
    number: task.number,
    key: taskKeyOf(project.task_key, task.number),
    title: task.title,
    status: task.status,
    typeLabel: WORK_TYPE_LABELS[task.type],
    priorityLabel: WORK_PRIORITY_LABELS[task.priority],
    priorityTone: PRIORITY_TONES[task.priority],
    assignee: task.assignee_email,
    labels: task.labels,
    dueOn: task.due_on,
    overdue: task.overdue,
    points: task.story_points,
    parentKey: task.parent_number === null ? null : taskKeyOf(project.task_key, task.parent_number),
    parentTitle: task.parent_title,
  }));

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
        action={`/projects/${projectId}/board`}
        query={query}
        members={members}
        labels={labels}
        epics={epicsOf(tasks)}
        taskKey={project.task_key}
        sorts={BOARD_SORTS}
        filtered={filtered}
      />

      <p className="mb-3 text-sm text-muted-foreground">
        {filtered ? `Showing ${shown.length} of ${tasks.length} tasks. ` : null}
        Drag cards between columns, or use a card&apos;s Move to menu.
        {query.sort !== 'rank'
          ? ' Cards keep this sort, so a drop lands at the end of its column.'
          : null}
      </p>

      {tasks.length > 0 && shown.length === 0 ? (
        <div className="mb-4">
          <EmptyNote>No tasks match these filters.</EmptyNote>
        </div>
      ) : null}

      <Board
        projectId={projectId}
        columns={WORK_STATUSES.map((s) => ({ status: s, label: WORK_STATUS_LABELS[s] }))}
        cards={cards}
        reorderable={query.sort === 'rank'}
      />
    </>
  );
}
