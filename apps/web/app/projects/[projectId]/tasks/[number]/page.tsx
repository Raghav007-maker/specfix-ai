import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  LINK_KINDS,
  WORK_TYPE_LABELS,
  getProjectDetail,
  getWorkItemByNumber,
  latestCiForTicket,
  linkLabel,
  listLinkableScenarios,
  listLinkableTickets,
  listMembers,
  listProjects,
  listWorkComments,
  listWorkEvents,
  listWorkItems,
  listWorkLinks,
  taskKeyOf,
  workTablesAvailable,
  type ScenarioCiRow,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Label,
  Notice,
  Pill,
  Select,
  Textarea,
  linkClasses,
  type PillTone,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import {
  addCommentAction,
  addLinkAction,
  deleteCommentAction,
  deleteTaskAction,
  removeLinkAction,
  updateTaskAction,
} from '../../../actions';
import {
  ActivityList,
  NotMigrated,
  PriorityPill,
  StatusPill,
  TaskFormFields,
} from '../../../work-ui';

const CI_TONES: Record<ScenarioCiRow['status'], PillTone> = {
  passed: 'positive',
  failed: 'negative',
  flaky: 'warning',
  skipped: 'neutral',
};

const stamp = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; number: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [{ projectId, number: numberParam }, { error, notice }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t), workTablesAvailable()]);
  const sidebarProject = projects.find((p) => p.id === projectId);
  const number = /^\d{1,9}$/.test(numberParam) ? Number(numberParam) : NaN;
  if (!sidebarProject || !Number.isSafeInteger(number)) notFound();

  const shell = (current: string, children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current={current}
        />
      }
    >
      {children}
    </AppShell>
  );
  if (!migrated) return shell('Task', <NotMigrated />);

  const [project, task] = await Promise.all([
    getProjectDetail(t, projectId),
    getWorkItemByNumber(t, projectId, number),
  ]);
  if (!project || !task) notFound();
  const [events, members, tickets, scenarios, comments, links, projectTasks, ci] =
    await Promise.all([
      listWorkEvents(t, { workItemId: task.id }, 50),
      listMembers(t),
      listLinkableTickets(t, projectId),
      listLinkableScenarios(t, projectId),
      listWorkComments(t, task.id),
      listWorkLinks(t, task.id),
      listWorkItems(t, projectId),
      task.scenario_id && task.ticket_id ? latestCiForTicket(t, task.ticket_id) : [],
    ]);
  const key = taskKeyOf(project.task_key, task.number);
  const keyOf = (n: number) => taskKeyOf(project.task_key, n);
  const canManage = tenant.role !== 'reviewer';
  const scenarioCi = ci.find((r) => r.scenario_id === task.scenario_id) ?? null;
  // Hidden fields every collaboration form sends, so its action can return here.
  const here = { projectId, taskId: task.id, number: String(task.number) };
  const hidden = (extra: Record<string, string> = {}) =>
    Object.entries({ ...here, ...extra }).map(([name, value]) => (
      <input key={name} type="hidden" name={name} value={value} />
    ));

  return shell(
    key,
    <>
      <div className="mb-6">
        <p className="font-mono text-[13px] text-muted-foreground">{key}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.012em]">{task.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <StatusPill status={task.status} />
          <PriorityPill priority={task.priority} />
          <span className="text-muted-foreground">{WORK_TYPE_LABELS[task.type]}</span>
          {task.overdue ? <span className="text-negative">Overdue</span> : null}
        </div>
      </div>

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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={updateTaskAction} className="space-y-4">
                {hidden()}
                <TaskFormFields
                  task={task}
                  members={members}
                  tickets={tickets}
                  scenarios={scenarios}
                  idPrefix="edit"
                />
                <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
              </form>
            </CardContent>
          </Card>

          <Card id="comments">
            <CardHeader>
              <CardTitle className="text-base">
                Comments{' '}
                <span className="font-normal tabular-nums text-muted-foreground">
                  {comments.length}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {comments.length === 0 ? (
                <EmptyNote>No comments yet.</EmptyNote>
              ) : (
                <ol className="space-y-4">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          <span className="font-medium text-text">
                            {c.author_email ?? 'Former member'}
                          </span>{' '}
                          · <time dateTime={c.created_at.toISOString()}>{stamp(c.created_at)}</time>
                        </span>
                        {c.author_id === user.id || canManage ? (
                          <ConfirmSubmit
                            action={deleteCommentAction}
                            fields={{ ...here, commentId: c.id }}
                            label="Delete"
                            pendingLabel="Deleting…"
                            title="Delete this comment?"
                            body="It is removed for everyone. This cannot be undone."
                            confirmLabel="Delete comment"
                            variant="ghost"
                          />
                        ) : null}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5">
                        {c.body}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              <form action={addCommentAction} className="space-y-2">
                {hidden()}
                <Label htmlFor="comment-body">Add a comment</Label>
                <Textarea id="comment-body" name="body" rows={3} maxLength={10000} required />
                <SubmitButton variant="outline" pendingLabel="Posting…">
                  Post comment
                </SubmitButton>
              </form>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardContent className="pt-5">
              <dl className="space-y-3 text-sm">
                <Row label="Reporter">{task.reporter_email ?? 'Unknown'}</Row>
                <Row label="Assignee">{task.assignee_email ?? 'Unassigned'}</Row>
                <Row label="Spec ticket">
                  {task.ticket_id ? (
                    <Link href={`/tickets/${task.ticket_id}/specs`} className={linkClasses}>
                      <span className="font-mono text-[13px]">{task.ticket_key}</span>{' '}
                      {task.ticket_title}
                    </Link>
                  ) : (
                    'None'
                  )}
                </Row>
                <Row label="Scenario">
                  {task.scenario_id && task.ticket_id ? (
                    <span className="space-y-1">
                      <Link href={`/tickets/${task.ticket_id}/specs`} className={linkClasses}>
                        {task.scenario_title}
                      </Link>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {scenarioCi ? (
                          <>
                            <Pill tone={CI_TONES[scenarioCi.status]}>CI {scenarioCi.status}</Pill>
                            {stamp(scenarioCi.received_at)}
                          </>
                        ) : (
                          <Pill tone="neutral">CI not reported</Pill>
                        )}
                      </span>
                    </span>
                  ) : (
                    'None'
                  )}
                </Row>
                <Row label="Sprint">
                  <Link href={`/projects/${projectId}/backlog`} className={linkClasses}>
                    {task.sprint_name ?? 'Backlog'}
                  </Link>
                </Row>
                <Row label="Created">{stamp(task.created_at)}</Row>
                <Row label="Updated">{stamp(task.updated_at)}</Row>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Linked tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {links.length === 0 ? (
                <EmptyNote>No linked tasks.</EmptyNote>
              ) : (
                <ul className="space-y-2">
                  {links.map((l) => (
                    <li
                      key={`${l.from_id}-${l.to_id}-${l.kind}`}
                      className="flex items-start justify-between gap-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="text-muted-foreground">
                          {linkLabel(l.kind, l.direction)}
                        </span>{' '}
                        <Link
                          href={`/projects/${projectId}/tasks/${l.other_number}`}
                          className={linkClasses}
                        >
                          <span className="font-mono text-[13px]">{keyOf(l.other_number)}</span>{' '}
                          {l.other_title}
                        </Link>{' '}
                        <StatusPill status={l.other_status} />
                      </span>
                      <form action={removeLinkAction}>
                        {hidden({ fromId: l.from_id, toId: l.to_id, kind: l.kind })}
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove link to ${keyOf(l.other_number)}`}
                        >
                          Remove
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {projectTasks.length > 1 ? (
                <form action={addLinkAction} className="space-y-2">
                  {hidden()}
                  <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
                    <Select name="kind" aria-label="Link type" defaultValue="relates">
                      {LINK_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {linkLabel(k, 'out')}
                        </option>
                      ))}
                    </Select>
                    <Select name="toId" aria-label="Task to link" required defaultValue="">
                      <option value="" disabled>
                        Choose a task
                      </option>
                      {projectTasks
                        .filter((p) => p.id !== task.id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {keyOf(p.number)} —{' '}
                            {p.title.length > 50 ? `${p.title.slice(0, 50)}…` : p.title}
                          </option>
                        ))}
                    </Select>
                  </div>
                  <SubmitButton variant="outline" size="sm" pendingLabel="Linking…">
                    Add link
                  </SubmitButton>
                </form>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityList events={events} projectId={projectId} empty="No activity yet." />
            </CardContent>
          </Card>

          {canManage ? (
            <ConfirmSubmit
              action={deleteTaskAction}
              fields={{ ...here, key }}
              label="Delete task"
              pendingLabel="Deleting…"
              title={`Delete ${key}?`}
              body="The task, its comments and its links are removed for everyone. Its activity stays in the project timeline. This cannot be undone."
              confirmLabel="Delete task"
              variant="destructive"
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
