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
  parseBoardQuery,
  sprintVelocity,
  listProjects,
  listSprints,
  listWorkItems,
  sprintCountRows,
  sprintBurndown,
  dayRange,
  summarizeCounts,
  taskKeyOf,
  workTablesAvailable,
  type SprintRow,
  type WorkItemRow,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Input,
  Label,
  Notice,
  Pill,
  SectionHeading,
  Select,
  Textarea,
  linkClasses,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import {
  completeSprintAction,
  createSprintAction,
  setTaskSprintAction,
  startSprintAction,
  updateSprintAction,
} from '../../actions';
import {
  NotMigrated,
  PriorityPill,
  ProgressBar,
  ProjectHeader,
  StatusPill,
  TaskFilters,
  epicsOf,
  isFiltered,
  shortDay,
} from '../../work-ui';
import { LineChart } from '../../line-chart';

/** "5 days left", "ends today", "ended 2 days ago" from a YYYY-MM-DD end date (UTC days). */
function daysLeft(endsOn: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(endsOn) - Date.parse(today)) / 86_400_000);
  if (days === 0) return 'ends today';
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} left`;
  return `ended ${-days} day${days === -1 ? '' : 's'} ago`;
}

function dates(sprint: SprintRow): string {
  if (!sprint.starts_on && !sprint.ends_on) return 'No dates set';
  return `${sprint.starts_on ?? '…'} → ${sprint.ends_on ?? '…'}`;
}

export default async function BacklogPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, search, user] = await Promise.all([params, searchParams, requireUser()]);
  const one = (k: string) => {
    const v = search[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const error = one('error');
  const notice = one('notice');
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
      projectView="backlog"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Backlog"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="backlog"
        canManage={tenant.role !== 'reviewer'}
      />
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);

  const [project, sprints, tasks, countRows, members] = await Promise.all([
    getProjectDetail(t, projectId),
    listSprints(t, projectId),
    listWorkItems(t, projectId),
    sprintCountRows(t, projectId),
    listMembers(t),
  ]);
  if (!project) notFound();

  // The backlog has no column order, so its default is newest first (the old fixed order).
  const parsed = parseBoardQuery(search);
  const query = { ...parsed, sort: parsed.sort === 'rank' ? ('created' as const) : parsed.sort };
  const filtered = isFiltered(query, 'created');
  const shown = applyBoardQuery(tasks, query, { userId: user.id, taskKey: project.task_key });
  const labels = [...new Set(tasks.flatMap((task) => task.labels))].sort((a, b) =>
    a.localeCompare(b)
  );
  const velocity = sprintVelocity(sprints, tasks);
  const pointsOf = (list: WorkItemRow[]) => list.reduce((n, x) => n + (x.story_points ?? 0), 0);

  const canManage = tenant.role !== 'reviewer';
  const active = sprints.find((s) => s.status === 'active') ?? null;
  const burn = active ? await sprintBurndown(t, active.id) : null;
  // Burn story points when the sprint has any estimates, else count tasks.
  const byPoints = Boolean(burn && burn.totalPoints > 0);
  const burnTotal = burn ? (byPoints ? burn.totalPoints : burn.total) : 0;
  const burnRemaining = burn ? (byPoints ? burn.remainingPoints : burn.remaining) : [];
  const burnUnit = byPoints ? 'points' : 'tasks';
  // Ideal line: straight from all work open on day one to none on the planned last day.
  const plannedDays = burn?.endsOn && burn.days[0] ? dayRange(burn.days[0], burn.endsOn).length : 0;
  const ideal = burn
    ? burn.days.map((_, i) =>
        plannedDays > 1 ? Math.max(0, burnTotal * (1 - i / (plannedDays - 1))) : null
      )
    : [];
  const planned = sprints.filter((s) => s.status === 'planned');
  const completed = sprints.filter((s) => s.status === 'completed');
  const open = sprints.filter((s) => s.status !== 'completed');
  // Lists show the filtered tasks; counts, points and charts always cover the whole sprint.
  const allInSprint = (id: string) => tasks.filter((task) => task.sprint_id === id);
  const bySprint = (id: string) => shown.filter((task) => task.sprint_id === id);
  const backlog = shown.filter((task) => !task.sprint_id && task.status !== 'done');
  const doneOutside = tasks.filter((task) => !task.sprint_id && task.status === 'done').length;
  const countsOf = (id: string) => summarizeCounts(countRows.filter((r) => r.sprint_id === id));
  const keyOf = (n: number) => taskKeyOf(project.task_key, n);

  const taskList = (list: WorkItemRow[], empty: string) =>
    list.length === 0 ? (
      <EmptyNote>{empty}</EmptyNote>
    ) : (
      <ul className="divide-y divide-rule rounded-lg border border-border">
        {list.map((task) => (
          <li
            key={task.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm"
          >
            <Link
              href={`/projects/${projectId}/tasks/${task.number}`}
              className={`${linkClasses} font-mono text-[13px]`}
            >
              {keyOf(task.number)}
            </Link>
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <span className="text-xs text-muted-foreground">{WORK_TYPE_LABELS[task.type]}</span>
            {task.story_points !== null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {task.story_points} pt
              </span>
            ) : null}
            <PriorityPill priority={task.priority} />
            <StatusPill status={task.status} />
            <form action={setTaskSprintAction} className="flex items-center gap-1.5">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="taskId" value={task.id} />
              <Select
                name="sprintId"
                aria-label={`Move ${keyOf(task.number)} to`}
                defaultValue={task.sprint_id ?? ''}
                className="h-8 w-40 text-xs max-sm:h-11"
              >
                <option value="">Backlog</option>
                {open.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === 'active' ? ' (active)' : ''}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="outline" size="sm">
                Move
              </Button>
            </form>
          </li>
        ))}
      </ul>
    );

  const sprintForm = (sprint?: SprintRow) => (
    <form
      action={sprint ? updateSprintAction : createSprintAction}
      className="grid gap-3 sm:grid-cols-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      {sprint ? <input type="hidden" name="sprintId" value={sprint.id} /> : null}
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${sprint?.id ?? 'new'}-name`}>Name</Label>
        <Input
          id={`${sprint?.id ?? 'new'}-name`}
          name="name"
          required
          maxLength={100}
          autoComplete="off"
          defaultValue={sprint?.name ?? `Sprint ${sprints.length + 1}`}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${sprint?.id ?? 'new'}-goal`}>Goal</Label>
        <Textarea
          id={`${sprint?.id ?? 'new'}-goal`}
          name="goal"
          rows={2}
          maxLength={1000}
          defaultValue={sprint?.goal}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${sprint?.id ?? 'new'}-start`}>Start date</Label>
        <Input
          id={`${sprint?.id ?? 'new'}-start`}
          name="startsOn"
          type="date"
          defaultValue={sprint?.starts_on ?? ''}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${sprint?.id ?? 'new'}-end`}>End date</Label>
        <Input
          id={`${sprint?.id ?? 'new'}-end`}
          name="endsOn"
          type="date"
          defaultValue={sprint?.ends_on ?? ''}
        />
      </div>
      <div className="sm:col-span-2">
        <SubmitButton variant="outline" pendingLabel="Saving…">
          {sprint ? 'Save sprint' : 'Create sprint'}
        </SubmitButton>
      </div>
    </form>
  );

  const editDetails = (sprint: SprintRow) =>
    canManage ? (
      <details className="rounded-lg border border-border">
        <summary className="flex h-10 cursor-pointer list-none items-center px-3 text-sm text-muted-foreground hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
          Edit sprint
        </summary>
        <div className="border-t border-border p-3">{sprintForm(sprint)}</div>
      </details>
    ) : null;

  return shell(
    <>
      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      ) : null}

      <TaskFilters
        action={`/projects/${projectId}/backlog`}
        query={query}
        members={members}
        labels={labels}
        epics={epicsOf(tasks)}
        taskKey={project.task_key}
        sorts={BOARD_SORTS.filter((v) => v !== 'rank')}
        filtered={filtered}
      />
      {filtered ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Showing {shown.length} of {tasks.length} tasks. Sprint progress and points still count
          every task.
        </p>
      ) : null}

      <div className="space-y-8">
        <section aria-labelledby="active-h" className="space-y-3">
          <SectionHeading id="active-h">Active sprint</SectionHeading>
          {active ? (
            (() => {
              const counts = countsOf(active.id);
              const remaining = counts.total - counts.byStatus.done;
              return (
                <Card>
                  <CardHeader className="border-b">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="text-base">{active.name}</CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {dates(active)}
                          {active.ends_on ? ` · ${daysLeft(active.ends_on)}` : ''}
                        </p>
                        {active.goal ? (
                          <p className="mt-2 whitespace-pre-wrap text-sm">{active.goal}</p>
                        ) : null}
                      </div>
                      {canManage ? (
                        <ConfirmSubmit
                          action={completeSprintAction}
                          fields={{ projectId, sprintId: active.id }}
                          label="Complete sprint"
                          pendingLabel="Completing…"
                          title={`Complete ${active.name}?`}
                          body={
                            remaining > 0
                              ? `${remaining} unfinished task${remaining === 1 ? '' : 's'} will move back to the backlog. Done tasks stay with the sprint.`
                              : 'Every task in this sprint is done.'
                          }
                          confirmLabel="Complete sprint"
                        />
                      ) : null}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 pt-4">
                    <ProgressBar
                      done={counts.byStatus.done}
                      total={counts.total}
                      label="Sprint progress"
                    />
                    {burn && burn.days.length > 1 ? (
                      <div>
                        <h3 className="mb-1 text-sm font-medium">
                          Burndown{' '}
                          <span className="font-normal text-muted-foreground">
                            ({byPoints ? 'story points' : 'tasks'})
                          </span>
                        </h3>
                        <LineChart
                          ariaLabel={`Unfinished ${burnUnit} per day: ${burn.days
                            .map((d, i) => `${shortDay(d)} ${burnRemaining[i]}`)
                            .join('; ')}`}
                          labels={burn.days.map(shortDay)}
                          series={[
                            {
                              name: byPoints ? 'Points left' : 'Remaining',
                              color: '#2b5fd9',
                              values: burnRemaining,
                            },
                          ]}
                          reference={plannedDays > 1 ? { name: 'Ideal', values: ideal } : undefined}
                        />
                      </div>
                    ) : null}
                    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                      <Figure label="Done" value={counts.byStatus.done} />
                      <Figure label="Remaining" value={remaining} />
                      <Figure
                        label="In progress or review"
                        value={counts.byStatus.in_progress + counts.byStatus.in_review}
                      />
                      <Figure label="Overdue" value={counts.overdue} warn={counts.overdue > 0} />
                      <Figure
                        label="Points done"
                        value={`${pointsOf(allInSprint(active.id).filter((x) => x.status === 'done'))} of ${pointsOf(allInSprint(active.id))}`}
                      />
                    </dl>
                    {taskList(
                      bySprint(active.id),
                      'No tasks in this sprint yet. Move some from the backlog.'
                    )}
                    {editDetails(active)}
                  </CardContent>
                </Card>
              );
            })()
          ) : (
            <EmptyNote>
              No active sprint.{' '}
              {canManage
                ? planned.length
                  ? 'Start a planned sprint below.'
                  : 'Create a sprint below, add tasks, then start it.'
                : 'An owner or admin starts sprints.'}
            </EmptyNote>
          )}
        </section>

        <section aria-labelledby="planned-h" className="space-y-3">
          <SectionHeading id="planned-h" count={planned.length}>
            Planned sprints
          </SectionHeading>
          {planned.length === 0 ? <EmptyNote>No planned sprints.</EmptyNote> : null}
          {planned.map((sprint) => {
            const list = bySprint(sprint.id);
            return (
              <Card key={sprint.id}>
                <CardHeader className="border-b">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base">
                        {sprint.name}{' '}
                        <span className="font-normal tabular-nums text-muted-foreground">
                          {list.length}
                        </span>
                      </CardTitle>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dates(sprint)} · {pointsOf(allInSprint(sprint.id))} points planned
                      </p>
                      {sprint.goal ? (
                        <p className="mt-2 whitespace-pre-wrap text-sm">{sprint.goal}</p>
                      ) : null}
                    </div>
                    {canManage ? (
                      active ? (
                        <p className="text-xs text-muted-foreground">
                          Complete the active sprint to start this one.
                        </p>
                      ) : (
                        <form action={startSprintAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="sprintId" value={sprint.id} />
                          <SubmitButton pendingLabel="Starting…">Start sprint</SubmitButton>
                        </form>
                      )
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                  {taskList(list, 'No tasks planned for this sprint yet.')}
                  {editDetails(sprint)}
                </CardContent>
              </Card>
            );
          })}
          {canManage ? (
            <details
              className="rounded-lg border border-border bg-sheet"
              open={sprints.length === 0}
            >
              <summary className="flex h-11 cursor-pointer list-none items-center px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
                + New sprint
              </summary>
              <div className="border-t border-border p-4">{sprintForm()}</div>
            </details>
          ) : null}
        </section>

        <section aria-labelledby="backlog-h" className="space-y-3">
          <SectionHeading id="backlog-h" count={backlog.length}>
            Backlog
          </SectionHeading>
          <p className="text-sm text-muted-foreground">
            Unfinished tasks that are in no sprint.
            {doneOutside
              ? ` ${doneOutside} done task${doneOutside === 1 ? '' : 's'} outside sprints are not listed.`
              : ''}
          </p>
          {taskList(
            backlog,
            tasks.length === 0
              ? 'No tasks in this project yet. Use Create at the top to add one.'
              : 'The backlog is empty.'
          )}
        </section>

        {completed.length > 0 ? (
          <section aria-labelledby="completed-h" className="space-y-3">
            <SectionHeading id="completed-h" count={completed.length}>
              Completed sprints
            </SectionHeading>
            {velocity.length > 1 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Velocity</CardTitle>
                </CardHeader>
                <CardContent>
                  <LineChart
                    ariaLabel={`Finished per completed sprint: ${velocity
                      .map((v) => `${v.name} ${v.points} points, ${v.tasks} tasks`)
                      .join('; ')}`}
                    labels={velocity.map((v) => v.name)}
                    series={[
                      { name: 'Points', color: '#2b5fd9', values: velocity.map((v) => v.points) },
                      { name: 'Tasks', color: '#c07a2c', values: velocity.map((v) => v.tasks) },
                    ]}
                  />
                </CardContent>
              </Card>
            ) : null}
            <ul className="space-y-2">
              {completed.map((sprint) => {
                const list = allInSprint(sprint.id);
                return (
                  <li key={sprint.id}>
                    <details className="rounded-lg border border-border bg-sheet">
                      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
                        <span className="font-medium">{sprint.name}</span>
                        <span className="text-muted-foreground">{dates(sprint)}</span>
                        <Pill tone="positive">
                          {list.length} done · {pointsOf(list)} pts
                        </Pill>
                        {sprint.completed_at ? (
                          <span className="text-xs text-muted-foreground">
                            completed {sprint.completed_at.toLocaleDateString('en-GB')}
                          </span>
                        ) : null}
                      </summary>
                      <div className="border-t border-border p-3">
                        {list.length === 0 ? (
                          <EmptyNote>No tasks were finished in this sprint.</EmptyNote>
                        ) : (
                          <ul className="space-y-1 text-sm">
                            {list.map((task) => (
                              <li key={task.id}>
                                <Link
                                  href={`/projects/${projectId}/tasks/${task.number}`}
                                  className={`${linkClasses} font-mono text-[13px]`}
                                >
                                  {keyOf(task.number)}
                                </Link>{' '}
                                {task.title}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}

function Figure({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          warn
            ? 'text-lg font-semibold tabular-nums text-negative'
            : 'text-lg font-semibold tabular-nums'
        }
      >
        {value}
      </dd>
    </div>
  );
}
