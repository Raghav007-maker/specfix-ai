import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  LINK_KINDS,
  SPEC_REVIEW_TYPES,
  listAttachments,
  WORK_TYPE_LABELS,
  getProjectDetail,
  getWorkItemByNumber,
  latestCiForTicket,
  linkLabel,
  listLinkableScenarios,
  listLinkableTickets,
  listProjectPeople,
  listProjects,
  formatMinutes,
  listTimeEntries,
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
  Input,
  Label,
  Notice,
  Pill,
  Select,
  Textarea,
  buttonClasses,
  linkClasses,
  type PillTone,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ATTACHMENTS_PER_TASK, ATTACHMENT_ACCEPT, formatBytes } from '@specfix/shared';
import { attachmentsReady } from '@/lib/storage';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import {
  addCommentAction,
  addLinkAction,
  deleteCommentAction,
  deleteTimeEntryAction,
  logTimeAction,
  deleteTaskAction,
  removeLinkAction,
  sendForSpecReviewAction,
  uploadAttachmentAction,
  deleteAttachmentAction,
  updateTaskAction,
} from '../../../actions';
import {
  ActivityList,
  NotMigrated,
  PriorityPill,
  ProgressBar,
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
  const [projects, migrated] = await Promise.all([listProjects(t, user.id), workTablesAvailable()]);
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
  const [events, members, tickets, scenarios, comments, links, projectTasks, ci, time, files] =
    await Promise.all([
      listWorkEvents(t, { workItemId: task.id }, 50),
      listProjectPeople(t, projectId),
      listLinkableTickets(t, projectId),
      listLinkableScenarios(t, projectId),
      listWorkComments(t, task.id),
      listWorkLinks(t, task.id),
      listWorkItems(t, projectId),
      task.scenario_id && task.ticket_id ? latestCiForTicket(t, task.ticket_id) : [],
      listTimeEntries(t, task.id),
      listAttachments(t, user.id, task.id),
    ]);
  const totalMinutes = time.reduce((n, e) => n + e.minutes, 0);
  const key = taskKeyOf(project.task_key, task.number);
  const keyOf = (n: number) => taskKeyOf(project.task_key, n);
  const canManage = sidebarProject.role !== 'reviewer';
  const scenarioCi = ci.find((r) => r.scenario_id === task.scenario_id) ?? null;
  const children = projectTasks
    .filter((c) => c.parent_id === task.id)
    .sort((a, b) => a.number - b.number);
  const formProps = {
    task,
    members,
    tickets,
    scenarios,
    tasks: projectTasks,
    taskKey: project.task_key,
  };
  const childrenDone = children.filter((c) => c.status === 'done');
  const points = (list: typeof children) => list.reduce((n, c) => n + (c.story_points ?? 0), 0);
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
        <p className="font-mono text-[13px] text-muted-foreground">
          {task.parent_number !== null ? (
            <>
              <Link
                href={`/projects/${projectId}/tasks/${task.parent_number}`}
                className={linkClasses}
                title={task.parent_title ?? undefined}
              >
                {keyOf(task.parent_number)}
              </Link>
              {' / '}
            </>
          ) : null}
          {key}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.012em]">{task.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <StatusPill status={task.status} />
          <PriorityPill priority={task.priority} />
          <span className="text-muted-foreground">{WORK_TYPE_LABELS[task.type]}</span>
          {task.story_points !== null ? (
            <span className="text-muted-foreground tabular-nums">
              {task.story_points} {task.story_points === 1 ? 'point' : 'points'}
            </span>
          ) : null}
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardContent className="space-y-4 pt-5">
              {/* Part of the Details form on the right, so one Save keeps every field. */}
              <TaskFormFields {...formProps} part="main" formId="task-edit" idPrefix="edit-main" />
              <div className="flex justify-end">
                <Button type="submit" form="task-edit" variant="outline" size="sm">
                  Save changes
                </Button>
              </div>
            </CardContent>
          </Card>

          {SPEC_REVIEW_TYPES.includes(task.type) ? (
            <Card id="spec-review">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">Spec review</CardTitle>
                  {task.ticket_id ? (
                    <Pill tone="accent">In review</Pill>
                  ) : (
                    <Pill tone="neutral">Not sent</Pill>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {task.ticket_id
                    ? 'This task is a spec ticket. After you change its description or acceptance criteria, send it again so the review reads the new text.'
                    : 'Send this task to spec review: its description and acceptance criteria are checked for vague language, missing information and criteria no test could fail.'}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {!task.acceptance_criteria.trim() ? (
                  <Notice tone="warning">
                    No acceptance criteria yet. You can still send it, but the review will flag
                    their absence first.
                  </Notice>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <form action={sendForSpecReviewAction}>
                    {hidden()}
                    <SubmitButton size="sm" pendingLabel="Sending…">
                      {task.ticket_id ? 'Send changes for review' : 'Send for spec review'}
                    </SubmitButton>
                  </form>
                  {task.ticket_id ? (
                    <Link href={`/tickets/${task.ticket_id}`} className={linkClasses}>
                      Open the review of{' '}
                      <span className="font-mono text-[13px]">{task.ticket_key}</span>
                    </Link>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card id="files">
            <CardHeader>
              <CardTitle className="text-base">
                Files{' '}
                <span className="font-normal tabular-nums text-muted-foreground">
                  {files.length}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {files.length === 0 ? (
                <EmptyNote>No files yet. Attach screenshots, logs or documents.</EmptyNote>
              ) : (
                <ul className="divide-y divide-rule overflow-hidden rounded-lg border border-border">
                  {files.map((f) => (
                    <li
                      key={f.id}
                      className="row-hover flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                    >
                      <a
                        href={`/attachments/${f.id}`}
                        className={`${linkClasses} min-w-0 flex-1 truncate font-medium`}
                        title={f.file_name}
                      >
                        {f.file_name}
                      </a>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatBytes(f.size_bytes)} · {f.uploader_email ?? 'Former member'} ·{' '}
                        {stamp(f.created_at)}
                      </span>
                      {f.uploaded_by === user.id || canManage ? (
                        <ConfirmSubmit
                          action={deleteAttachmentAction}
                          fields={{ ...here, attachmentId: f.id }}
                          label="Remove"
                          pendingLabel="Removing…"
                          title={`Remove ${f.file_name}?`}
                          body="The file is deleted for everyone and cannot be brought back."
                          confirmLabel="Remove"
                          variant="ghost"
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {!attachmentsReady() ? (
                <p className="text-xs text-muted-foreground">
                  File uploads are not set up on this server (SUPABASE_SERVICE_ROLE_KEY).
                </p>
              ) : files.length >= ATTACHMENTS_PER_TASK ? (
                <p className="text-xs text-muted-foreground">
                  This task holds the most files it can ({ATTACHMENTS_PER_TASK}). Remove one to add
                  another.
                </p>
              ) : (
                <form action={uploadAttachmentAction} className="flex flex-wrap items-center gap-3">
                  {hidden()}
                  <input
                    type="file"
                    name="file"
                    required
                    accept={ATTACHMENT_ACCEPT}
                    aria-label="File to attach"
                    className="min-w-0 flex-1 text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-control file:bg-sheet file:px-3 file:py-1.5 file:text-sm file:text-text hover:file:border-field"
                  />
                  <SubmitButton size="sm" variant="outline" pendingLabel="Uploading…">
                    Attach
                  </SubmitButton>
                  <p className="w-full text-xs text-muted-foreground">
                    Up to 10 MB: images, PDF, text, CSV, JSON, ZIP, DOCX or XLSX.
                  </p>
                </form>
              )}
            </CardContent>
          </Card>

          {task.type !== 'subtask' ? (
            <Card id="children">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {task.type === 'epic' ? 'Tasks in this epic' : 'Sub-tasks'}{' '}
                    <span className="font-normal tabular-nums text-muted-foreground">
                      {children.length}
                    </span>
                  </CardTitle>
                  <Link
                    href={`/projects/${projectId}/tasks/new?parent=${task.id}`}
                    className={buttonClasses('outline', 'sm')}
                  >
                    {task.type === 'epic' ? 'Add task' : 'Add sub-task'}
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {children.length === 0 ? (
                  <EmptyNote>
                    {task.type === 'epic' ? 'No tasks in this epic yet.' : 'No sub-tasks yet.'}
                  </EmptyNote>
                ) : (
                  <>
                    <ProgressBar
                      done={childrenDone.length}
                      total={children.length}
                      label={
                        points(children)
                          ? `Progress · ${points(childrenDone)} of ${points(children)} points done`
                          : 'Progress'
                      }
                    />
                    <ul className="divide-y divide-rule rounded-lg border border-border">
                      {children.map((c) => (
                        <li
                          key={c.id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                        >
                          <Link
                            href={`/projects/${projectId}/tasks/${c.number}`}
                            className={`${linkClasses} font-mono text-[13px]`}
                          >
                            {keyOf(c.number)}
                          </Link>
                          <span className="min-w-0 flex-1 truncate">{c.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {WORK_TYPE_LABELS[c.type]}
                          </span>
                          {c.story_points !== null ? (
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {c.story_points} pt
                            </span>
                          ) : null}
                          <StatusPill status={c.status} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}

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
                <Textarea
                  id="comment-body"
                  name="body"
                  rows={3}
                  maxLength={10000}
                  required
                  placeholder="Type @name to notify a teammate by email."
                />
                <SubmitButton variant="outline" pendingLabel="Posting…">
                  Post comment
                </SubmitButton>
              </form>
            </CardContent>
          </Card>

          <Card id="time" className="scroll-mt-20">
            <CardHeader>
              <CardTitle className="text-base">
                Time logged{' '}
                <span className="font-normal tabular-nums text-muted-foreground">
                  {formatMinutes(totalMinutes)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {time.length === 0 ? (
                <EmptyNote>No time logged yet.</EmptyNote>
              ) : (
                <ul className="divide-y divide-rule text-sm">
                  {time.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="tabular-nums font-medium">{formatMinutes(e.minutes)}</span>
                      <span className="text-muted-foreground">
                        {e.email ?? 'Former member'} · {e.spent_on}
                      </span>
                      {e.note ? <span className="min-w-0 flex-1 truncate">{e.note}</span> : null}
                      {e.user_id === user.id ? (
                        <form action={deleteTimeEntryAction} className="ml-auto">
                          {hidden()}
                          <input type="hidden" name="entryId" value={e.id} />
                          <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                            Delete
                          </SubmitButton>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <form
                action={logTimeAction}
                className="grid gap-2 sm:grid-cols-[5rem_5rem_9rem_1fr_auto]"
              >
                {hidden()}
                <Input
                  type="number"
                  name="hours"
                  min={0}
                  max={24}
                  step={1}
                  placeholder="h"
                  aria-label="Hours"
                />
                <Input
                  type="number"
                  name="minutes"
                  min={0}
                  max={1440}
                  step={1}
                  placeholder="min"
                  aria-label="Minutes"
                />
                <Input
                  type="date"
                  name="spentOn"
                  required
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  aria-label="Day"
                />
                <Input
                  name="note"
                  maxLength={200}
                  placeholder="What you did (optional)"
                  aria-label="Note"
                />
                <SubmitButton variant="outline" pendingLabel="Logging…">
                  Log time
                </SubmitButton>
              </form>
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
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <form id="task-edit" action={updateTaskAction} className="space-y-4">
                {hidden()}
                <TaskFormFields {...formProps} part="details" idPrefix="edit" />
                <SubmitButton pendingLabel="Saving…" className="w-full">
                  Save changes
                </SubmitButton>
              </form>
            </CardContent>
          </Card>

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
