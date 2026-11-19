import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  activeSprintSummaries,
  weeklyThroughput,
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  getProjectDetail,
  listProjects,
  listWorkEvents,
  listWorkItems,
  summarizeCounts,
  taskKeyOf,
  workCountRows,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle, EmptyNote, Notice } from '@/components/ui';
import { LineChart } from '../line-chart';
import {
  ActivityList,
  NotMigrated,
  ProgressBar,
  ProjectHeader,
  ProjectStatusForm,
  ProjectStatusPill,
  shortDay,
} from '../work-ui';

/**
 * A project's Summary, as in Jira: how the work stands, at a glance. Nothing here edits; tasks
 * are created on their own page, listed on List, and the project is changed on Settings.
 */
export default async function ProjectSummaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [{ projectId }, { error, notice }, user] = await Promise.all([
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
  const canManage = sidebarProject.role !== 'reviewer';

  const shell = (aside: ReactNode, children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      projectView="summary"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: '/projects', label: 'Projects' }}
          current={sidebarProject.name}
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="summary"
        canManage={canManage}
        aside={aside}
      />
      {children}
    </AppShell>
  );
  if (!migrated) return shell(null, <NotMigrated />);

  const [project, rows, tasks, events, [activeSprint], weeks] = await Promise.all([
    getProjectDetail(t, projectId),
    workCountRows(t, projectId),
    listWorkItems(t, projectId),
    listWorkEvents(t, { projectId }, 15),
    activeSprintSummaries(t, projectId),
    weeklyThroughput(t, projectId, 12),
  ]);
  if (!project) notFound();
  const counts = summarizeCounts(rows);
  const keyOf = (n: number) => taskKeyOf(project.task_key, n);

  // Open work per person, most loaded first; unassigned last.
  const open = tasks.filter((task) => task.status !== 'done');
  const workload = [
    ...open
      .reduce((m, task) => {
        const who = task.assignee_email ?? '';
        return m.set(who, (m.get(who) ?? 0) + 1);
      }, new Map<string, number>())
      .entries(),
  ]
    .map(([who, value]) => ({ label: who || 'Unassigned', value, unassigned: !who }))
    .sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || b.value - a.value);

  const epics = tasks
    .filter((task) => task.type === 'epic')
    .map((epic) => {
      const children = tasks.filter((task) => task.parent_id === epic.id);
      return {
        epic,
        total: children.length,
        done: children.filter((c) => c.status === 'done').length,
      };
    });

  return shell(
    <>
      {sidebarProject.role === 'owner' ? (
        <ProjectStatusForm projectId={projectId} status={project.status} from="summary" />
      ) : (
        <ProjectStatusPill status={project.status} />
      )}
      {project.task_key ? (
        <span className="font-mono text-[13px] text-muted-foreground">{project.task_key}</span>
      ) : null}
    </>,
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

      <p className="-mt-2 mb-6 max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">
        {project.description || 'No description yet.'}{' '}
        <span className="text-xs">· Spec tickets come from tasks sent for spec review</span>
      </p>

      <section aria-label="Totals" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Total tasks" value={counts.total} />
        <Metric label="Done" value={counts.byStatus.done} note={`${counts.percentDone}% of all`} />
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

      {counts.total === 0 ? (
        <div className="mb-6">
          <EmptyNote>
            No tasks yet.{' '}
            <Link
              href={`/projects/${projectId}/tasks/new`}
              className="underline underline-offset-[3px]"
            >
              Create the first one
            </Link>
            .
          </EmptyNote>
        </div>
      ) : null}

      <div className="stagger grid gap-6 lg:grid-cols-2">
        <SummaryCard title="Status overview" note="Every task in the project, by status.">
          <div className="space-y-5">
            <ProgressBar
              done={counts.byStatus.done}
              total={counts.total}
              label="Project progress"
            />
            <Breakdown
              items={WORK_STATUSES.map((s) => ({
                label: WORK_STATUS_LABELS[s],
                value: counts.byStatus[s],
              }))}
              total={counts.total}
            />
          </div>
        </SummaryCard>

        <SummaryCard title="Types of work" note="How the project's tasks split by type.">
          <Breakdown
            items={WORK_TYPES.map((k) => ({ label: WORK_TYPE_LABELS[k], value: counts.byType[k] }))}
            total={counts.total}
          />
        </SummaryCard>

        <SummaryCard title="Active sprint">
          {activeSprint ? (
            <div className="space-y-3">
              <ProgressBar
                done={activeSprint.done}
                total={activeSprint.total}
                label={activeSprint.name}
              />
              {activeSprint.ends_on ? (
                <p className="text-xs text-muted-foreground">Ends {activeSprint.ends_on}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No sprint is running.</p>
          )}
          <Link
            href={`/projects/${projectId}/backlog`}
            className="mt-3 inline-block text-sm underline-offset-[3px] hover:underline"
          >
            Open backlog
          </Link>
        </SummaryCard>

        <SummaryCard title="Team workload" note="Unfinished tasks per assignee.">
          {workload.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unfinished tasks.</p>
          ) : (
            <Breakdown items={workload} total={open.length} wideLabel />
          )}
        </SummaryCard>

        {epics.length > 0 ? (
          <SummaryCard title="Epic progress" note="Done of the tasks under each epic.">
            <ul className="space-y-4">
              {epics.map(({ epic, total, done }) => (
                <li key={epic.id}>
                  <Link
                    href={`/projects/${projectId}/tasks/${epic.number}`}
                    className="mb-1 block truncate text-sm underline-offset-[3px] hover:underline"
                  >
                    <span className="font-mono text-[13px] text-muted-foreground">
                      {keyOf(epic.number)}
                    </span>{' '}
                    {epic.title}
                  </Link>
                  <ProgressBar done={done} total={total} label={`${epic.title} progress`} />
                </li>
              ))}
            </ul>
          </SummaryCard>
        ) : null}

        <SummaryCard title="Recent activity">
          <ActivityList
            events={events}
            projectId={projectId}
            projectKey={project.task_key}
            empty="Nothing has happened in this project yet."
          />
        </SummaryCard>

        <div className="lg:col-span-2">
          <SummaryCard
            title="Created and completed per week"
            note="Last 12 weeks, from the project's activity. Completed counts tasks moved to Done."
          >
            <LineChart
              ariaLabel={`Tasks created and completed per week over the last 12 weeks: ${weeks
                .map((w) => `${shortDay(w.week)} ${w.created} created, ${w.completed} completed`)
                .join('; ')}`}
              labels={weeks.map((w) => shortDay(w.week))}
              series={[
                { name: 'Created', color: '#2b5fd9', values: weeks.map((w) => w.created) },
                { name: 'Completed', color: '#c07a2c', values: weeks.map((w) => w.completed) },
              ]}
            />
          </SummaryCard>
        </div>
      </div>
    </>
  );
}

function SummaryCard({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
  items,
  total,
  wideLabel,
}: {
  items: { label: string; value: number }[];
  total: number;
  /** Room for an email instead of a short label. */
  wideLabel?: boolean;
}) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.label}
          className={
            wideLabel
              ? 'grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_2rem] items-center gap-2 text-sm'
              : 'grid grid-cols-[6.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-sm'
          }
        >
          <span className="truncate text-muted-foreground" title={item.label}>
            {item.label}
          </span>
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
  );
}
