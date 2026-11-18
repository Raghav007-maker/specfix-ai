import type { ReactNode } from 'react';
import Link from 'next/link';
import { getUser } from '@/lib/session';
import { PublicLanding } from '@/components/public-pages';
import { requireTenant, currentMemberships } from '@/lib/tenant';
import {
  activeSprintSummaries,
  inProjects,
  listAssignedWorkItems,
  listProjectDetails,
  listProjects,
  listWorkEvents,
  projectScope,
  summarizeCounts,
  taskKeyOf,
  workCountRows,
  workTablesAvailable,
  type ProjectDetailRow,
} from '@/lib/repos';
import { loadWorkspaceDashboard, profileOf } from '@/lib/dashboard';
import type { QueueItem } from '@/components/playground/dashboard-data';
import { switchTenant, createProjectForCurrentTenant } from './actions';
import { AppShell } from '@/components/app-shell';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Input,
  Notice,
  Pill,
  Select,
  linkClasses,
  type PillTone,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  PriorityPill,
  ProgressBar,
  ProjectStatusPill,
  StatusPill,
  describeEvent,
} from './projects/work-ui';

type Tab = 'work' | 'reviews' | 'activity';

type ReviewState = 'need' | 'waiting' | 'resolved' | 'ready';
const REVIEW: Record<ReviewState, { label: string; tone: PillTone }> = {
  need: { label: 'Needs decision', tone: 'warning' },
  waiting: { label: 'Not analysed', tone: 'neutral' },
  resolved: { label: 'Flags resolved', tone: 'accent' },
  ready: { label: 'Ready for dev', tone: 'positive' },
};
const reviewState = (r: QueueItem): ReviewState =>
  !r.analyzed ? 'waiting' : r.ready ? 'ready' : r.openFlags > 0 ? 'need' : 'resolved';

const when = (d: Date) =>
  new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Home, as Jira's "Your work": your projects at the top, then what is yours to do — tasks
 * assigned to you across projects, the spec review queue, and recent activity — with active
 * sprints and the resolution agent beside them. `?project=` narrows the review queue to one
 * project (the project's "Spec queue" view).
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; error?: string; tab?: string }>;
}) {
  // Signed-out visitors get the public landing page; signed-in users get their work. Every
  // existing redirect to "/" comes from a signed-in flow, so it still lands here.
  const user = await getUser();
  if (!user) return <PublicLanding />;

  const [memberships, { project: projectParam, error, tab: tabParam }] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t, user.id), workTablesAvailable()]);

  // Only a project of this workspace narrows the queue; anything else shows them all.
  const activeProject = projects.find((p) => p.id === projectParam);
  const tab: Tab =
    tabParam === 'work' || tabParam === 'reviews' || tabParam === 'activity'
      ? tabParam
      : activeProject
        ? 'reviews'
        : 'work';

  const [{ data, agent }, allDetails, allCountRows, allAssigned, allSprints, events] =
    await Promise.all([
      loadWorkspaceDashboard(user, tenant, projects, activeProject?.id),
      migrated ? listProjectDetails(t) : Promise.resolve([] as ProjectDetailRow[]),
      migrated ? workCountRows(t) : Promise.resolve([]),
      migrated ? listAssignedWorkItems(t, user.id) : Promise.resolve([]),
      migrated ? activeSprintSummaries(t) : Promise.resolve([]),
      migrated
        ? listWorkEvents(t, { projectIds: projectScope(tenant, projects) }, 15)
        : Promise.resolve([]),
    ]);
  // Tenant-wide reads, kept to the projects this person can see.
  const visible = new Set(projects.map((p) => p.id));
  const details = allDetails.filter((p) => visible.has(p.id));
  const countRows = inProjects(allCountRows, projects);
  const assigned = inProjects(allAssigned, projects);
  const sprints = inProjects(allSprints, projects);

  const byId = new Map(details.map((p) => [p.id, p]));
  const keyOf = (projectId: string, n: number) =>
    taskKeyOf(byId.get(projectId)?.task_key ?? null, n);
  const name = profileOf(user, tenant).name ?? user.email ?? 'there';
  const openFlags = data.queue.reduce((n, r) => n + r.openFlags, 0);
  const ready = data.queue.filter((r) => r.ready).length;
  const overdueMine = assigned.filter((task) => task.overdue).length;
  const canCreate = tenant.role === 'owner';

  const tabLink = (key: Tab, label: string, count?: number) => {
    const params = new URLSearchParams({ tab: key });
    if (activeProject) params.set('project', activeProject.id);
    return (
      <Link
        key={key}
        href={`/?${params}`}
        aria-current={tab === key ? 'page' : undefined}
        className={cn(
          'inline-flex h-10 flex-none items-center gap-1.5 border-b-2 px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
          tab === key
            ? 'border-text font-medium text-text'
            : 'border-transparent text-muted-foreground hover:text-text'
        )}
      >
        {label}
        {count !== undefined ? (
          <span className="rounded-full bg-raised px-1.5 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={activeProject?.id}
      projectView={activeProject ? 'queue' : undefined}
      current={activeProject ? 'projects' : 'queue'}
      breadcrumb={
        <p className="truncate text-sm text-muted-foreground">
          {tenant.tenant_name}
          {activeProject ? ` / ${activeProject.name} spec queue` : ''}
        </p>
      }
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.012em]">Your work</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Hello, {name}. Here is what needs you in {tenant.tenant_name}.
          </p>
        </div>
        {memberships.length > 1 ? (
          <form action={switchTenant} className="flex flex-wrap items-center gap-2">
            <Select
              name="tenantId"
              aria-label="Workspace"
              defaultValue={tenant.tenant_id}
              className="h-9 w-auto"
            >
              {memberships.map((m) => (
                <option key={m.tenant_id} value={m.tenant_id}>
                  {m.tenant_name}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" variant="outline">
              Switch workspace
            </Button>
          </form>
        ) : null}
      </div>

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}

      {projects.length === 0 ? (
        <NoProjects canCreate={canCreate} />
      ) : (
        <>
          <section
            aria-label="At a glance"
            className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            <Metric label="Assigned to me" value={assigned.length} note="Unfinished tasks" />
            <Metric
              label="My overdue tasks"
              value={overdueMine}
              warn={overdueMine > 0}
              note="Past due, not done"
            />
            <Metric
              label="Flags to decide"
              value={openFlags}
              note={`On ${data.queue.filter((r) => r.openFlags > 0).length} spec tickets`}
            />
            <Metric
              label="Tickets ready for dev"
              value={ready}
              note={`of ${data.queue.length} spec tickets`}
            />
          </section>

          <section aria-labelledby="projects-h" className="mb-8">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 id="projects-h" className="text-base font-semibold">
                Projects
              </h2>
              <Link href="/projects" className={`${linkClasses} text-sm`}>
                View all projects
              </Link>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {projects.slice(0, 6).map((p) => {
                const counts = summarizeCounts(countRows.filter((r) => r.project_id === p.id));
                const open = counts.total - counts.byStatus.done;
                const detail = byId.get(p.id);
                return (
                  <li key={p.id}>
                    <Card className="flex h-full flex-col p-4">
                      <div className="flex items-start justify-between gap-2">
                        <Link
                          href={`/projects/${p.id}`}
                          className="min-w-0 truncate font-medium underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                        >
                          {p.name}
                        </Link>
                        {detail?.task_key ? (
                          <span className="flex-none font-mono text-xs text-muted-foreground">
                            {detail.task_key}
                          </span>
                        ) : null}
                      </div>
                      {detail ? (
                        <div className="mt-1.5">
                          <ProjectStatusPill status={detail.status} />
                        </div>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {migrated
                          ? `${open} open task${open === 1 ? '' : 's'}${counts.overdue ? ` · ${counts.overdue} overdue` : ''}`
                          : 'Task tracking not set up'}
                      </p>
                      {migrated && counts.total > 0 ? (
                        <div className="mt-3">
                          <ProgressBar
                            done={counts.byStatus.done}
                            total={counts.total}
                            label="Progress"
                          />
                        </div>
                      ) : null}
                      <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-3 text-sm">
                        <Link href={`/projects/${p.id}/board`} className={linkClasses}>
                          Board
                        </Link>
                        <Link href={`/projects/${p.id}/backlog`} className={linkClasses}>
                          Backlog
                        </Link>
                        <Link href={`/?project=${p.id}`} className={linkClasses}>
                          Spec queue
                        </Link>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0">
              <nav
                aria-label="Your work"
                className="-mx-1 mb-4 flex gap-1 overflow-x-auto overflow-y-hidden px-1 shadow-[inset_0_-1px_0_rgb(var(--border))]"
              >
                {tabLink('work', 'Assigned to me', assigned.length)}
                {tabLink('reviews', 'Spec reviews', data.queue.length)}
                {tabLink('activity', 'Recent activity')}
              </nav>

              {tab === 'work' ? (
                !migrated ? (
                  <EmptyNote>Task tracking is not set up on this database yet.</EmptyNote>
                ) : assigned.length === 0 ? (
                  <EmptyNote>Nothing is assigned to you right now.</EmptyNote>
                ) : (
                  <ul className="divide-y divide-rule rounded-lg border border-border bg-sheet">
                    {assigned.map((task) => (
                      <li
                        key={task.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-sm"
                      >
                        <Link
                          href={`/projects/${task.project_id}/tasks/${task.number}`}
                          className={`${linkClasses} font-mono text-[13px]`}
                        >
                          {keyOf(task.project_id, task.number)}
                        </Link>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{task.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {byId.get(task.project_id)?.name ?? 'Project'}
                            {task.sprint_name ? ` · ${task.sprint_name}` : ''}
                          </span>
                        </span>
                        <PriorityPill priority={task.priority} />
                        <StatusPill status={task.status} />
                        {task.due_on ? (
                          <span
                            className={cn(
                              'text-xs tabular-nums',
                              task.overdue ? 'text-negative' : 'text-muted-foreground'
                            )}
                          >
                            {task.overdue ? 'Overdue ' : 'Due '}
                            {task.due_on}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {tab === 'reviews' ? (
                <>
                  {activeProject ? (
                    <p className="mb-3 text-sm text-muted-foreground">
                      Spec tickets of {activeProject.name}.{' '}
                      <Link href="/?tab=reviews" className={linkClasses}>
                        Show every project
                      </Link>
                    </p>
                  ) : null}
                  {data.queue.length === 0 ? (
                    <EmptyNote>
                      No spec tickets yet. Ingest tickets into a project to start reviewing.
                    </EmptyNote>
                  ) : (
                    <ul className="divide-y divide-rule rounded-lg border border-border bg-sheet">
                      {[...data.queue]
                        .sort((a, b) => b.openFlags - a.openFlags)
                        .map((r) => {
                          const st = REVIEW[reviewState(r)];
                          return (
                            <li
                              key={r.id}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-sm"
                            >
                              <Link
                                href={`/tickets/${r.id}`}
                                className={`${linkClasses} font-mono text-[13px]`}
                              >
                                {r.key}
                              </Link>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{r.title}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {r.project}
                                </span>
                              </span>
                              <span className="text-xs tabular-nums text-muted-foreground">
                                {r.analyzed
                                  ? r.totalFlags === 0
                                    ? 'No flags'
                                    : `${r.openFlags} of ${r.totalFlags} flags open`
                                  : '—'}
                              </span>
                              <Pill tone={st.tone}>{st.label}</Pill>
                            </li>
                          );
                        })}
                    </ul>
                  )}
                </>
              ) : null}

              {tab === 'activity' ? (
                events.length === 0 ? (
                  <EmptyNote>No task activity in this workspace yet.</EmptyNote>
                ) : (
                  <ol className="space-y-3 rounded-lg border border-border bg-sheet p-4">
                    {events.map((e) => (
                      <li key={e.id} className="text-sm leading-5">
                        <p>
                          <span className="font-medium">{e.actor_email ?? 'Someone'}</span>{' '}
                          {describeEvent(e)}
                          {e.item_number !== null ? (
                            <>
                              {' '}
                              on{' '}
                              {e.work_item_id ? (
                                <Link
                                  href={`/projects/${e.project_id}/tasks/${e.item_number}`}
                                  className="font-mono text-[13px] underline-offset-[3px] hover:underline"
                                >
                                  {keyOf(e.project_id, e.item_number)}
                                </Link>
                              ) : (
                                <span className="font-mono text-[13px]">
                                  {keyOf(e.project_id, e.item_number)}
                                </span>
                              )}
                              {e.item_title ? (
                                <span className="text-muted-foreground"> {e.item_title}</span>
                              ) : null}
                            </>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {byId.get(e.project_id)?.name ?? 'Project'} ·{' '}
                          <time dateTime={new Date(e.created_at).toISOString()}>
                            {when(e.created_at)}
                          </time>
                        </p>
                      </li>
                    ))}
                  </ol>
                )
              ) : null}
            </div>

            <div className="space-y-6">
              <SideCard title="Active sprints">
                {sprints.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sprint is running.</p>
                ) : (
                  <ul className="space-y-4">
                    {sprints.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={`/projects/${s.project_id}/backlog`}
                          className="mb-1 block truncate text-xs text-muted-foreground underline-offset-[3px] hover:underline"
                        >
                          {s.project_name}
                          {s.ends_on ? ` · ends ${s.ends_on}` : ''}
                        </Link>
                        <ProgressBar done={s.done} total={s.total} label={s.name} />
                      </li>
                    ))}
                  </ul>
                )}
              </SideCard>

              {agent && data.agent.state === 'ready' ? (
                <SideCard title="Resolution agent">{agent}</SideCard>
              ) : null}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
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
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', warn && 'text-negative')}>
        {value}
      </p>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </Card>
  );
}

/** Owners and admins can create a project here; reviewers are told who can. */
function NoProjects({ canCreate }: { canCreate: boolean }) {
  return (
    <section
      aria-labelledby="no-projects-h"
      className="max-w-xl rounded-xl border border-border bg-sheet p-5"
    >
      <h2 id="no-projects-h" className="font-semibold">
        No projects yet
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {canCreate
          ? 'Create a project, then add tasks or ingest spec tickets into it.'
          : 'Ask an owner or admin of this workspace to create a project.'}
      </p>
      {canCreate ? (
        <form action={createProjectForCurrentTenant} className="mt-4 flex gap-2">
          <Input
            name="name"
            aria-label="Project name"
            placeholder="Project name"
            autoComplete="off"
            required
            className="max-w-xs"
          />
          <Button type="submit">Create project</Button>
        </form>
      ) : null}
    </section>
  );
}
