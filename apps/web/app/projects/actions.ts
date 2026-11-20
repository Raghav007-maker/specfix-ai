'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  ChatError,
  ProjectAccessError,
  RateLimiter,
  RequestError,
  decideProjectJoin,
  deleteTimeEntry,
  logTime,
  setProjectMember,
  setProjectStatus,
  WorkError,
  postProjectMessage,
  addWorkComment,
  addWorkLink,
  completeSprint,
  createSprint,
  createWorkItem,
  deleteWorkComment,
  fileBugFromScenario,
  removeWorkLink,
  setWorkItemSprint,
  startSprint,
  updateSprint,
  deleteWorkItem,
  moveWorkItem,
  updateProjectDetails,
  updateWorkItem,
  sendTaskForSpecReview,
  AttachmentError,
  addAttachment,
  deleteAttachment,
  discardAttachment,
  type RawTaskInput,
} from '@/lib/repos';
import { checkAttachment } from '@specfix/shared';
import { embedTicketVersions } from '@specfix/sync';
import { attachmentsReady, putAttachment, removeAttachments } from '@/lib/storage';

/**
 * Project and task writes. Each action resolves the user and their current tenant; the
 * repository re-reads the actor's role and re-checks every id against the tenant inside
 * its own transaction, so a stale page or a hand-built post cannot reach another
 * workspace's rows or exceed the actor's role.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : null;
};

function taskInput(formData: FormData): RawTaskInput {
  const keys = [
    'title',
    'description',
    'acceptanceCriteria',
    'type',
    'priority',
    'status',
    'assigneeId',
    'dueOn',
    'labels',
    'components',
    'ticketId',
    'scenarioId',
    'parentId',
    'storyPoints',
  ] as const;
  return Object.fromEntries(keys.map((k) => [k, field(formData, k)]));
}

/** Only a well-formed id goes into a redirect path; anything else lands on the list. */
function projectPath(projectId: string | null, rest = ''): string {
  return projectId && UUID.test(projectId) ? `/projects/${projectId}${rest}` : '/projects';
}

function back(path: string, message: { error?: string; notice?: string }): never {
  const params = new URLSearchParams();
  if (message.error) params.set('error', message.error);
  if (message.notice) params.set('notice', message.notice);
  redirect(`${path}?${params}`);
}

async function actor() {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  return { user, tenantId: tenant.tenant_id };
}

/** Runs a write; a WorkError comes back as its message, anything else is thrown. */
async function run<T>(write: () => Promise<T>): Promise<{ ok: T } | { error: string }> {
  try {
    return { ok: await write() };
  } catch (error) {
    if (
      error instanceof WorkError ||
      error instanceof ProjectAccessError ||
      error instanceof RequestError ||
      error instanceof AttachmentError
    ) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Creates a task; the board's quick add (`from=board`) returns to the board, else the task opens. */
export async function createTaskAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId') ?? '';
  const fromBoard = field(formData, 'from') === 'board';
  const result = await run(() => createWorkItem(tenantId, user.id, projectId, taskInput(formData)));
  if ('error' in result) {
    back(projectPath(projectId, fromBoard ? '/board' : '/tasks/new'), { error: result.error });
  }
  back(projectPath(projectId, fromBoard ? '/board' : `/tasks/${result.ok.number}`), {
    notice: `Created ${result.ok.key}.`,
  });
}

/**
 * A board drag or a card's "Move to" menu. Called from the board script, so it answers with
 * a refusal message instead of redirecting, and refreshes the board's data on success.
 */
export async function moveTaskAction(formData: FormData): Promise<{ error?: string }> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    moveWorkItem(tenantId, user.id, field(formData, 'taskId') ?? '', {
      status: field(formData, 'status') ?? '',
      beforeId: field(formData, 'beforeId'),
    })
  );
  if ('error' in result) return { error: result.error };
  revalidatePath(projectPath(result.ok.projectId, '/board'));
  revalidatePath(projectPath(result.ok.projectId));
  return {};
}

export async function updateTaskAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const number = Number(field(formData, 'number'));
  const here = projectPath(projectId, Number.isSafeInteger(number) ? `/tasks/${number}` : '');
  const result = await run(() =>
    updateWorkItem(tenantId, user.id, field(formData, 'taskId') ?? '', taskInput(formData))
  );
  if ('error' in result) back(here, { error: result.error });
  back(here, { notice: result.ok.length ? 'Saved.' : 'Nothing changed.' });
}

/**
 * Sends a task to spec review: its text becomes a spec ticket (or a new version of it). Nothing
 * is analyzed here; an admin starts analysis from the project's spec queue.
 */
export async function sendForSpecReviewAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const number = Number(field(formData, 'number'));
  const here = projectPath(projectId, Number.isSafeInteger(number) ? `/tasks/${number}` : '');
  const result = await run(() =>
    sendTaskForSpecReview(tenantId, user.id, field(formData, 'taskId') ?? '')
  );
  if ('error' in result) back(here, { error: result.error });
  // Best effort, and free when the stored vectors already match: a missing vector only hides
  // similarity hints, and re-sending (or the backfill) fills it in.
  const problem = await embedTicketVersions(tenantId, [result.ok.versionId]).catch((e) =>
    e instanceof Error ? e.message : String(e)
  );
  if (problem) console.error('[spec-review] embedding failed:', problem);
  back(here, {
    notice: result.ok.isNewVersion
      ? `Sent ${result.ok.key} for spec review. An admin can start its analysis from the spec queue.`
      : `${result.ok.key} has not changed since it was last sent.`,
  });
}

export async function deleteTaskAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const key = field(formData, 'key') ?? 'the task';
  const result = await run(() =>
    deleteWorkItem(tenantId, user.id, field(formData, 'taskId') ?? '')
  );
  if ('error' in result) {
    const number = Number(field(formData, 'number'));
    back(projectPath(projectId, Number.isSafeInteger(number) ? `/tasks/${number}` : ''), {
      error: result.error,
    });
  }
  await removeAttachments(result.ok.storagePaths);
  back(projectPath(result.ok.projectId), { notice: `Deleted ${key.slice(0, 20)}.` });
}

// Uploads cost storage and bandwidth: a generous hourly allowance per person.
const uploadsByUser = new RateLimiter('attachment-upload', 60, 60 * 60_000);

/**
 * Attaches one file to a task. The file is checked (size, type, and that its first bytes
 * match its extension), the row is added under the task's lock (limit and project access
 * re-checked there), then the bytes are stored; a failed store removes the row again.
 */
export async function uploadAttachmentAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const number = Number(field(formData, 'number'));
  const here = projectPath(projectId, Number.isSafeInteger(number) ? `/tasks/${number}` : '');
  const fail = (error: string): never => back(`${here}`, { error });

  if (!attachmentsReady()) fail('File attachments are not set up on this server.');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) fail('Choose a file to attach.');
  const upload = file as File;
  const head = new Uint8Array(await upload.slice(0, 16).arrayBuffer());
  const checked = checkAttachment({ name: upload.name, size: upload.size, head });
  if (!checked.ok) fail(checked.error);
  if (!(await uploadsByUser.take(user.id))) fail('Too many uploads. Try again in an hour.');
  const ok = checked as Extract<typeof checked, { ok: true }>;

  const result = await run(() =>
    addAttachment(tenantId, user.id, field(formData, 'taskId') ?? '', {
      name: ok.name,
      contentType: ok.contentType,
      size: upload.size,
    })
  );
  if ('error' in result) fail(result.error);
  const row = (result as { ok: Awaited<ReturnType<typeof addAttachment>> }).ok;
  try {
    await putAttachment(row.storage_path, upload, ok.contentType);
  } catch (error) {
    console.error('[attachments] upload failed:', error instanceof Error ? error.message : error);
    await discardAttachment(tenantId, row.id);
    fail('Could not store the file. Please try again.');
  }
  revalidatePath(here);
  back(`${here}`, { notice: `Attached ${ok.name}.` });
}

/** Removes a file: whoever added it, or a project admin (re-checked in the repository). */
export async function deleteAttachmentAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const number = Number(field(formData, 'number'));
  const here = projectPath(projectId, Number.isSafeInteger(number) ? `/tasks/${number}` : '');
  const result = await run(() =>
    deleteAttachment(tenantId, user.id, field(formData, 'attachmentId') ?? '')
  );
  if ('error' in result) back(here, { error: result.error });
  await removeAttachments([result.ok.storagePath]);
  back(here, { notice: `Removed ${result.ok.fileName}.` });
}

export async function updateProjectAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId') ?? '';
  const result = await run(() =>
    updateProjectDetails(tenantId, user.id, projectId, {
      description: field(formData, 'description') ?? '',
      taskKey: field(formData, 'taskKey') ?? '',
    })
  );
  if ('error' in result) back(projectPath(projectId, '/settings'), { error: result.error });
  back(projectPath(projectId, '/settings'), { notice: 'Project details saved.' });
}

/** Owner-only: the project's status (running, on hold, completed, archived). */
export async function setProjectStatusAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId') ?? '';
  const page = field(formData, 'from') === 'settings' ? '/settings' : '';
  const result = await run(() =>
    setProjectStatus(tenantId, user.id, projectId, field(formData, 'status') ?? '')
  );
  if ('error' in result) back(projectPath(projectId, page), { error: result.error });
  back(projectPath(projectId, page), { notice: 'Project status updated.' });
}

/** The task page a collaboration form came from, rebuilt from validated parts only. */
function taskPath(formData: FormData): string {
  const number = Number(field(formData, 'number'));
  return projectPath(
    field(formData, 'projectId'),
    Number.isSafeInteger(number) && number > 0 ? `/tasks/${number}` : ''
  );
}

export async function addCommentAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    addWorkComment(tenantId, user.id, field(formData, 'taskId') ?? '', field(formData, 'body'))
  );
  if ('error' in result) back(taskPath(formData), { error: result.error });
  redirect(`${taskPath(formData)}#comments`);
}

export async function deleteCommentAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    deleteWorkComment(tenantId, user.id, field(formData, 'commentId') ?? '')
  );
  if ('error' in result) back(taskPath(formData), { error: result.error });
  back(taskPath(formData), { notice: 'Comment deleted.' });
}

export async function addLinkAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    addWorkLink(tenantId, user.id, {
      fromId: field(formData, 'taskId') ?? '',
      toId: field(formData, 'toId') ?? '',
      kind: field(formData, 'kind') ?? '',
    })
  );
  if ('error' in result) back(taskPath(formData), { error: result.error });
  back(taskPath(formData), {
    notice: result.ok.added ? 'Link added.' : 'That link already exists.',
  });
}

export async function removeLinkAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    removeWorkLink(tenantId, user.id, {
      fromId: field(formData, 'fromId') ?? '',
      toId: field(formData, 'toId') ?? '',
      kind: field(formData, 'kind') ?? '',
    })
  );
  if ('error' in result) back(taskPath(formData), { error: result.error });
  back(taskPath(formData), { notice: 'Link removed.' });
}

/** "File bug" on a scenario's CI result: opens the new bug, or the one already open for it. */
export async function fileBugAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const ticketId = field(formData, 'ticketId');
  const result = await run(() =>
    fileBugFromScenario(tenantId, user.id, field(formData, 'scenarioId') ?? '')
  );
  if ('error' in result) {
    back(ticketId && UUID.test(ticketId) ? `/tickets/${ticketId}/specs` : '/projects', {
      error: result.error,
    });
  }
  back(projectPath(result.ok.projectId, `/tasks/${result.ok.number}`), {
    notice: result.ok.existing
      ? `${result.ok.key} is already open for this scenario.`
      : `Filed ${result.ok.key}.`,
  });
}

const sprintInput = (formData: FormData) => ({
  name: field(formData, 'name'),
  goal: field(formData, 'goal'),
  startsOn: field(formData, 'startsOn'),
  endsOn: field(formData, 'endsOn'),
});

const backlogPath = (formData: FormData) => projectPath(field(formData, 'projectId'), '/backlog');

/** Creates a planned sprint (owners and admins), then returns to the backlog. */
export async function createSprintAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    createSprint(tenantId, user.id, field(formData, 'projectId') ?? '', sprintInput(formData))
  );
  if ('error' in result) back(backlogPath(formData), { error: result.error });
  back(backlogPath(formData), { notice: 'Sprint created.' });
}

export async function updateSprintAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    updateSprint(tenantId, user.id, field(formData, 'sprintId') ?? '', sprintInput(formData))
  );
  if ('error' in result) back(backlogPath(formData), { error: result.error });
  back(backlogPath(formData), { notice: 'Sprint saved.' });
}

export async function startSprintAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() => startSprint(tenantId, user.id, field(formData, 'sprintId') ?? ''));
  if ('error' in result) back(backlogPath(formData), { error: result.error });
  back(backlogPath(formData), { notice: 'Sprint started.' });
}

export async function completeSprintAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    completeSprint(tenantId, user.id, field(formData, 'sprintId') ?? '')
  );
  if ('error' in result) back(backlogPath(formData), { error: result.error });
  const { done, returned } = result.ok;
  back(backlogPath(formData), {
    notice: `Sprint completed: ${done} done, ${returned} moved back to the backlog.`,
  });
}

/** A backlog row's "Move to" form: a sprint id, or empty for the backlog. */
export async function setTaskSprintAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const sprintId = field(formData, 'sprintId');
  const result = await run(() =>
    setWorkItemSprint(tenantId, user.id, field(formData, 'taskId') ?? '', sprintId || null)
  );
  if ('error' in result) back(backlogPath(formData), { error: result.error });
  redirect(backlogPath(formData));
}

const messagesByUser = new RateLimiter('chat-user', 20, 60_000);

/** Posts to a project's team conversation; @mentions notify (and email) those members. */
export async function postMessageAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const here = projectPath(projectId, '/conversation');
  // At most 20 messages a minute per person, so one account cannot flood a team (or its inboxes).
  if (!(await messagesByUser.take(user.id))) {
    back(here, { error: 'You are sending messages too fast. Wait a minute and try again.' });
  }
  let sent = { mentioned: 0, everyone: 0 };
  try {
    sent = await postProjectMessage(tenantId, user.id, projectId ?? '', field(formData, 'body'));
  } catch (error) {
    if (error instanceof ChatError) back(here, { error: error.message });
    throw error;
  }
  revalidatePath(here);
  const parts = [
    sent.mentioned ? `${sent.mentioned} mentioned member(s) will get an email` : '',
    sent.everyone ? `${sent.everyone} more see it in their inbox (@all is never emailed)` : '',
  ].filter(Boolean);
  back(here, parts.length ? { notice: `Sent. ${parts.join('; ')}.` } : {});
}

/**
 * Adds a team member to a project, changes their project role, or removes them (`role=remove`).
 * The repository decides what the actor may do (owner: anything; project admin: reviewers).
 */
export async function setProjectMemberAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId') ?? '';
  const userId = field(formData, 'userId') ?? '';
  const raw = field(formData, 'role');
  const role = raw === 'admin' || raw === 'reviewer' ? raw : raw === 'remove' ? null : undefined;
  const here = projectPath(projectId, '/people');
  if (role === undefined) back(here, { error: 'Choose admin or reviewer.' });
  const result = await run(() => setProjectMember(tenantId, user.id, { projectId, userId, role }));
  if ('error' in result) back(here, { error: result.error });
  back(here, {
    notice: role
      ? `Saved: now ${role === 'admin' ? 'an admin' : 'a reviewer'}.`
      : 'Removed from the project.',
  });
}

/** A project admin (or owner) lets someone who asked join as a reviewer, or turns them down. */
export async function decideProjectJoinAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId');
  const approve = field(formData, 'decision') === 'approve';
  const result = await run(() =>
    decideProjectJoin(tenantId, user.id, field(formData, 'requestId') ?? '', approve)
  );
  if ('error' in result) back(projectPath(projectId, '/people'), { error: result.error });
  back(projectPath(result.ok.projectId, '/people'), {
    notice: approve ? 'Added to the project as a reviewer.' : 'Request turned down.',
  });
}

/** Logs the signed-in person's time on a task. */
export async function logTimeAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    logTime(tenantId, user.id, field(formData, 'taskId') ?? '', {
      minutes: Number(field(formData, 'hours') || 0) * 60 + Number(field(formData, 'minutes') || 0),
      spentOn: field(formData, 'spentOn'),
      note: field(formData, 'note'),
    })
  );
  if ('error' in result) back(taskPath(formData), { error: result.error });
  redirect(`${taskPath(formData)}#time`);
}

export async function deleteTimeEntryAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const result = await run(() =>
    deleteTimeEntry(tenantId, user.id, field(formData, 'entryId') ?? '')
  );
  if ('error' in result) back(taskPath(formData), { error: result.error });
  redirect(`${taskPath(formData)}#time`);
}
