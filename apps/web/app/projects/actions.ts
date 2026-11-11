'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  WorkError,
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
  type RawTaskInput,
} from '@/lib/repos';

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
    'type',
    'priority',
    'status',
    'assigneeId',
    'dueOn',
    'labels',
    'components',
    'ticketId',
    'scenarioId',
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
    if (error instanceof WorkError) return { error: error.message };
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
    back(projectPath(projectId, fromBoard ? '/board' : ''), { error: result.error });
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
  back(projectPath(result.ok.projectId), { notice: `Deleted ${key.slice(0, 20)}.` });
}

export async function updateProjectAction(formData: FormData): Promise<void> {
  const { user, tenantId } = await actor();
  const projectId = field(formData, 'projectId') ?? '';
  const result = await run(() =>
    updateProjectDetails(tenantId, user.id, projectId, {
      description: field(formData, 'description') ?? '',
      status: field(formData, 'status') ?? '',
      taskKey: field(formData, 'taskKey') ?? '',
    })
  );
  if ('error' in result) back(projectPath(projectId), { error: result.error });
  back(projectPath(projectId), { notice: 'Project details saved.' });
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
