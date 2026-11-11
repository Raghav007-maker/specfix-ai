import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  BOARD_SORTS,
  BOARD_SORT_LABELS,
  WORK_PRIORITIES,
  WORK_PRIORITY_LABELS,
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  WORK_TYPES,
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
import { Button, EmptyNote, Input, Label, Notice, Select, buttonClasses } from '@/components/ui';
import type { PillTone } from '@/components/ui';
import { NotMigrated, ProjectTabs } from '../../work-ui';
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
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Board"
        />
      }
    >
      <h1 className="mb-4 text-2xl font-semibold tracking-[-0.012em]">{sidebarProject.name}</h1>
      <ProjectTabs projectId={projectId} active="board" />
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
  const filtered =
    Boolean(query.q || query.type || query.priority || query.assignee || query.label) ||
    query.sort !== 'rank';
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

      <form
        method="get"
        role="search"
        aria-label="Filter the board"
        className="mb-4 grid gap-3 rounded-lg border border-border bg-sheet p-3 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1.5fr)_repeat(5,minmax(0,1fr))_auto]"
      >
        <FilterField label="Search" htmlFor="board-q">
          <Input
            id="board-q"
            name="q"
            type="search"
            defaultValue={query.q}
            maxLength={100}
            placeholder="Title, label or id"
            autoComplete="off"
          />
        </FilterField>
        <FilterField label="Type" htmlFor="board-type">
          <Select id="board-type" name="type" defaultValue={query.type ?? ''}>
            <option value="">All types</option>
            {WORK_TYPES.map((v) => (
              <option key={v} value={v}>
                {WORK_TYPE_LABELS[v]}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Priority" htmlFor="board-priority">
          <Select id="board-priority" name="priority" defaultValue={query.priority ?? ''}>
            <option value="">All priorities</option>
            {WORK_PRIORITIES.map((v) => (
              <option key={v} value={v}>
                {WORK_PRIORITY_LABELS[v]}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Assignee" htmlFor="board-assignee">
          <Select id="board-assignee" name="assignee" defaultValue={query.assignee ?? ''}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">Unassigned</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.email ?? 'Member'}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Label" htmlFor="board-label">
          <Select id="board-label" name="label" defaultValue={query.label ?? ''}>
            <option value="">Any label</option>
            {labels.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Sort" htmlFor="board-sort">
          <Select id="board-sort" name="sort" defaultValue={query.sort}>
            {BOARD_SORTS.map((v) => (
              <option key={v} value={v}>
                {BOARD_SORT_LABELS[v]}
              </option>
            ))}
          </Select>
        </FilterField>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="outline">
            Apply
          </Button>
          {filtered ? (
            <Link href={`/projects/${projectId}/board`} className={buttonClasses('ghost')}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

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

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
