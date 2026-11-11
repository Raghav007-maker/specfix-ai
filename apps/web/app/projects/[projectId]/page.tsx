import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  PROJECT_STATUSES,
  activeSprintSummaries,
  PROJECT_STATUS_LABELS,
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  getProjectDetail,
  listLinkableScenarios,
  listLinkableTickets,
  listMembers,
  listProjects,
  listWorkEvents,
  listWorkItems,
  summarizeCounts,
  taskKeyOf,
  workCountRows,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Input,
  Label,
  Notice,
  SectionHeading,
  Select,
  Textarea,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { createTaskAction, updateProjectAction } from '../actions';
import {
  ActivityList,
  NotMigrated,
  PriorityPill,
  ProgressBar,
  ProjectStatusPill,
  ProjectTabs,
  StatusPill,
  TaskFormFields,
} from '../work-ui';

export default async function ProjectOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; notice?: string; ticket?: string }>;
}) {
  const [{ projectId }, { error, notice, ticket: ticketParam }, user] = await Promise.all([
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
          parent={{ href: '/projects', label: 'Projects' }}
          current={sidebarProject.name}
        />
      }
    >
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);

  const [project, rows, tasks, events, members, tickets, scenarios, [activeSprint]] =
    await Promise.all([
      getProjectDetail(t, projectId),
      workCountRows(t, projectId),
      listWorkItems(t, projectId),
      listWorkEvents(t, { projectId }, 25),
      listMembers(t),
      listLinkableTickets(t, projectId),
      listLinkableScenarios(t, projectId),
      activeSprintSummaries(t, projectId),
    ]);
  if (!project) notFound();
  const counts = summarizeCounts(rows);
  // "New task for this ticket" from a ticket's Specs tab preselects it, if it is in this project.
  const prefillTicket = tickets.find((tk) => tk.id === ticketParam)?.id;
  const canManage = tenant.role !== 'reviewer';

  return shell(
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-[-0.012em]">{project.name}</h1>
            <ProjectStatusPill status={project.status} />
          </div>
          <p className="mt-1 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">
            {project.description || 'No description yet.'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {project.source_type === 'jira'
              ? `Spec tickets synced from Jira project ${project.jira_project_key}`
              : 'Spec tickets from file import'}
            {project.task_key ? (
              <>
                {' · '}Task ids start with <span className="font-mono">{project.task_key}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <ProjectTabs projectId={projectId} active="overview" />

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

      <section aria-label="Summary" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Total tasks" value={counts.total} />
        <Metric label="Done" value={counts.byStatus.done} />
        <Metric
          label="In progress"
          value={counts.byStatus.in_progress + counts.byStatus.in_review}
          note={`${counts.byStatus.in_review} in review`}
        />
        <Metric
          label="Overdue"
          value={counts.overdue}
          warn={counts.overdue > 0}
          note="Past due, not done"
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardContent className="space-y-5 pt-5">
              <ProgressBar
                done={counts.byStatus.done}
                total={counts.total}
                label="Project progress"
              />
              <div className="grid gap-5 sm:grid-cols-2">
                <Breakdown
                  title="By status"
                  items={WORK_STATUSES.map((s) => ({
                    label: WORK_STATUS_LABELS[s],
                    value: counts.byStatus[s],
                  }))}
                  total={counts.total}
                />
                <Breakdown
                  title="By type"
                  items={WORK_TYPES.map((k) => ({
                    label: WORK_TYPE_LABELS[k],
                    value: counts.byType[k],
                  }))}
                  total={counts.total}
                />
              </div>
            </CardContent>
          </Card>

          <section aria-labelledby="tasks-h" className="space-y-3">
            <SectionHeading id="tasks-h" count={tasks.length}>
              Tasks
            </SectionHeading>
            <details
              id="new-task"
              className="group rounded-lg border border-border bg-sheet"
              open={tasks.length === 0 || Boolean(prefillTicket)}
            >
              <summary className="flex h-11 cursor-pointer list-none items-center px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
                + New task
              </summary>
              <form action={createTaskAction} className="space-y-4 border-t border-border p-4">
                <input type="hidden" name="projectId" value={projectId} />
                <TaskFormFields
                  members={members}
                  tickets={tickets}
                  scenarios={scenarios}
                  defaultTicketId={prefillTicket}
                  idPrefix="new"
                />
                <SubmitButton pendingLabel="Creating…">Create task</SubmitButton>
              </form>
            </details>
            {tasks.length === 0 ? (
              <EmptyNote>No tasks in this project yet. Create the first one above.</EmptyNote>
            ) : (
              <Card className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Key
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Title
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Type
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Priority
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Assignee
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Due
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {tasks.map((task) => (
                      <tr key={task.id}>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[13px]">
                          <Link
                            href={`/projects/${projectId}/tasks/${task.number}`}
                            className="rounded-sm underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                          >
                            {taskKeyOf(project.task_key, task.number)}
                          </Link>
                        </td>
                        <td className="max-w-[18rem] truncate px-4 py-2.5">{task.title}</td>
                        <td className="px-4 py-2.5">{WORK_TYPE_LABELS[task.type]}</td>
                        <td className="px-4 py-2.5">
                          <PriorityPill priority={task.priority} />
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusPill status={task.status} />
                        </td>
                        <td className="max-w-[12rem] truncate px-4 py-2.5 text-muted-foreground">
                          {task.assignee_email ?? 'Unassigned'}
                        </td>
                        <td
                          className={
                            task.overdue
                              ? 'whitespace-nowrap px-4 py-2.5 tabular-nums text-negative'
                              : 'whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground'
                          }
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
          </section>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Active sprint</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {activeSprint ? (
                <>
                  <ProgressBar
                    done={activeSprint.done}
                    total={activeSprint.total}
                    label={activeSprint.name}
                  />
                  {activeSprint.ends_on ? (
                    <p className="text-xs text-muted-foreground">Ends {activeSprint.ends_on}</p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No sprint is running.</p>
              )}
              <Link
                href={`/projects/${projectId}/backlog`}
                className="text-sm underline-offset-[3px] hover:underline"
              >
                Open backlog
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityList
                events={events}
                projectId={projectId}
                projectKey={project.task_key}
                empty="Nothing has happened in this project yet."
              />
            </CardContent>
          </Card>

          {canManage ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Project details</CardTitle>
              </CardHeader>
              <CardContent>
                <form action={updateProjectAction} className="space-y-4">
                  <input type="hidden" name="projectId" value={projectId} />
                  <div className="space-y-1.5">
                    <Label htmlFor="project-description">Description</Label>
                    <Textarea
                      id="project-description"
                      name="description"
                      rows={4}
                      maxLength={5000}
                      defaultValue={project.description}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="project-status">Status</Label>
                    <Select id="project-status" name="status" defaultValue={project.status}>
                      {PROJECT_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {PROJECT_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="project-key">Task key</Label>
                    <Input
                      id="project-key"
                      name="taskKey"
                      maxLength={10}
                      autoComplete="off"
                      defaultValue={project.task_key ?? ''}
                      placeholder="Set from the name on the first task"
                      className="font-mono uppercase"
                    />
                    <p className="text-xs text-muted-foreground">
                      2–10 letters or digits. Changing it renames every task id in this project.
                    </p>
                  </div>
                  <SubmitButton variant="outline" pendingLabel="Saving…">
                    Save details
                  </SubmitButton>
                </form>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: number;
  note?: string;
  warn?: boolean;
}) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={
          warn
            ? 'mt-1 text-2xl font-semibold tabular-nums text-negative'
            : 'mt-1 text-2xl font-semibold tabular-nums'
        }
      >
        {value}
      </p>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </Card>
  );
}

function Breakdown({
  title,
  items,
  total,
}: {
  title: string;
  items: { label: string; value: number }[];
  total: number;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li
            key={item.label}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-sm"
          >
            <span className="text-muted-foreground">{item.label}</span>
            <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-raised">
              <span
                className="block h-full rounded-full bg-text/70"
                style={{ width: `${total ? (item.value / total) * 100 : 0}%` }}
              />
            </span>
            <span className="text-right tabular-nums">{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
