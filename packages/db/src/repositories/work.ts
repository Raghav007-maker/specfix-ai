/**
 * Project work tracking: tasks (work items), their activity, and project details.
 *
 * Tasks are SpecFix's own and sit beside the spec tickets: a task may point at a ticket
 * or a scenario. Only sendTaskForSpecReview writes a ticket: the task's own text, as a new
 * version of its spec ticket.
 *
 * The rules:
 *   - every member (owner, admin, reviewer) can create and edit tasks;
 *   - only owners and admins delete tasks or change a project's details;
 *   - a task's assignee must be a member of the workspace, and its ticket or scenario
 *     must belong to the task's own project. Ids from forms are untrusted, so each is
 *     re-checked against the tenant inside the transaction that writes.
 *
 * Task numbers come from `projects.task_seq`, incremented in the inserting transaction:
 * the row lock serializes concurrent creates in one project, so no number repeats.
 * Every change appends to `work_item_events` in the same transaction as the change.
 */
import type { PoolClient } from 'pg';
import { tx, query, type TenantId } from '../client.ts';
import type { Role } from './members.ts';
import { projectRoleWith } from './project-members.ts';
import { notifyMentions, parseMentions } from './chat.ts';
import { ingestTicketWith } from './tickets.ts';

export const WORK_TYPES = ['task', 'bug', 'story', 'epic', 'subtask'] as const;
export const WORK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const WORK_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'archived'] as const;

export type WorkType = (typeof WORK_TYPES)[number];
export type WorkPriority = (typeof WORK_PRIORITIES)[number];
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  task: 'Task',
  bug: 'Bug',
  story: 'Story',
  epic: 'Epic',
  subtask: 'Sub-task',
};

/**
 * The hierarchy, one level per type: an epic has no parent, a story, task or bug may sit
 * under an epic, and a sub-task under a story, task or bug. Levels never repeat, so no
 * chain of parents can loop back on itself.
 */
/** "an epic", "a story". */
const aType = (t: WorkType) => `${t === 'epic' ? 'an' : 'a'} ${WORK_TYPE_LABELS[t].toLowerCase()}`;

export function parentTypesFor(type: WorkType): readonly WorkType[] {
  if (type === 'epic') return [];
  if (type === 'subtask') return ['story', 'task', 'bug'];
  return ['epic'];
}

export const WORK_PRIORITY_LABELS: Record<WorkPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};
export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Running',
  on_hold: 'On hold',
  completed: 'Completed',
  archived: 'Archived',
};

/** A refusal whose message is safe to show the user. */
export class WorkError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "SPX" and 12 → "SPX-12". A project gets its key on its first task. */
export function taskKeyOf(key: string | null, number: number): string {
  return `${key ?? 'TASK'}-${number}`;
}

/**
 * A default task-id prefix from a project name: initials of a multi-word name
 * ("Checkout Flow" → "CF"), else the first three letters ("Payments" → "PAY").
 */
export function deriveTaskKey(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const raw =
    words.length >= 2
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
      : (words[0] ?? '').slice(0, 3);
  const key = raw.replace(/^[0-9]+/, '');
  return TASK_KEY.test(key) ? key : 'TASK';
}

/** A prefix typed by a person: 2–10 letters/digits, starting with a letter. */
export function normalizeTaskKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!TASK_KEY.test(key)) {
    throw new WorkError('A task key is 2–10 letters or digits and starts with a letter, like SPX.');
  }
  return key;
}

/** "ui, Login ,ui" → ["ui", "Login"]: trimmed, de-duplicated ignoring case, order kept. */
export function parseTagList(raw: string | null | undefined, what = 'labels'): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const tag = part.trim().replace(/\s+/g, ' ');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new WorkError(`Each of the ${what} can be at most ${MAX_TAG_LENGTH} characters.`);
    }
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new WorkError(`A task can have at most ${MAX_TAGS} ${what}.`);
  return out;
}

/** "2026-11-30" → itself, '' → null; anything that is not a real calendar date is refused. */
export function parseDueDate(raw: string | null | undefined, what = 'due date'): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(`${value}T00:00:00Z`) : null;
  if (
    !match ||
    !date ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new WorkError(`Enter the ${what} as a real date, like 2026-11-30.`);
  }
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) throw new WorkError(`Enter a ${what} between 2000 and 2100.`);
  return value;
}

/** The fields a task form sends, as untrusted strings. */
export type RawTaskInput = Partial<
  Record<
    | 'title'
    | 'description'
    | 'acceptanceCriteria'
    | 'type'
    | 'priority'
    | 'status'
    | 'assigneeId'
    | 'dueOn'
    | 'labels'
    | 'components'
    | 'ticketId'
    | 'scenarioId'
    | 'parentId'
    | 'storyPoints',
    string | null
  >
>;

export interface TaskFields {
  title: string;
  description: string;
  /** What "done" means. A task sent for spec review is analyzed against it. */
  acceptanceCriteria: string;
  type: WorkType;
  priority: WorkPriority;
  status: WorkStatus;
  assigneeId: string | null;
  dueOn: string | null;
  labels: string[];
  components: string[];
  ticketId: string | null;
  scenarioId: string | null;
  parentId: string | null;
  storyPoints: number | null;
}

/** '' → null; otherwise a whole number from 0 to 100. */
export function parseStoryPoints(raw: string | null | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!/^\d{1,3}$/.test(value) || Number(value) > 100) {
    throw new WorkError('Story points are a whole number from 0 to 100.');
  }
  return Number(value);
}

const optionalId = (raw: string | null | undefined, what: string): string | null => {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!UUID.test(value)) throw new WorkError(`That ${what} is not in this project.`);
  return value.toLowerCase();
};

/** Validates a whole task form. Missing type, priority and status take their defaults. */
export function normalizeTaskInput(raw: RawTaskInput): TaskFields {
  const title = (raw.title ?? '').trim().replace(/\s+/g, ' ');
  if (!title) throw new WorkError('A task needs a title.');
  if (title.length > 200) throw new WorkError('A task title can be at most 200 characters.');
  const description = (raw.description ?? '').replace(/\r\n/g, '\n').trim();
  if (description.length > 20000) {
    throw new WorkError('A task description can be at most 20,000 characters.');
  }
  const acceptanceCriteria = (raw.acceptanceCriteria ?? '').replace(/\r\n/g, '\n').trim();
  if (acceptanceCriteria.length > 20000) {
    throw new WorkError('Acceptance criteria can be at most 20,000 characters.');
  }
  const pick = <T extends string>(list: readonly T[], value: string | null | undefined, d: T) => {
    if (!value) return d;
    if (!oneOf(list, value)) throw new WorkError('Choose one of the listed options.');
    return value;
  };
  return {
    title,
    description,
    acceptanceCriteria,
    type: pick(WORK_TYPES, raw.type, 'task'),
    priority: pick(WORK_PRIORITIES, raw.priority, 'medium'),
    status: pick(WORK_STATUSES, raw.status, 'todo'),
    assigneeId: optionalId(raw.assigneeId, 'assignee'),
    dueOn: parseDueDate(raw.dueOn),
    labels: parseTagList(raw.labels, 'labels'),
    components: parseTagList(raw.components, 'components'),
    ticketId: optionalId(raw.ticketId, 'ticket'),
    scenarioId: optionalId(raw.scenarioId, 'scenario'),
    parentId: optionalId(raw.parentId, 'parent task'),
    storyPoints: parseStoryPoints(raw.storyPoints),
  };
}

export type TaskField = keyof TaskFields;
export interface TaskChange {
  field: TaskField;
  from: string | null;
  to: string | null;
}

const asText = (v: TaskFields[TaskField]): string | null =>
  Array.isArray(v)
    ? v.length
      ? v.join(', ')
      : null
    : typeof v === 'number'
      ? String(v)
      : v === ''
        ? null
        : v;

/** What changed between two versions of a task, one entry per field, in form order. */
export function diffTask(before: TaskFields, after: TaskFields): TaskChange[] {
  return (Object.keys(after) as TaskField[])
    .map((field) => ({ field, from: asText(before[field]), to: asText(after[field]) }))
    .filter((c) => c.from !== c.to);
}

export interface WorkCounts {
  total: number;
  byStatus: Record<WorkStatus, number>;
  byType: Record<WorkType, number>;
  overdue: number;
  /** Done as a whole percentage of all tasks; 0 when there are none. */
  percentDone: number;
}

export interface WorkCountRow {
  project_id: string;
  status: WorkStatus;
  type: WorkType;
  count: number;
  overdue: number;
}

/** Folds grouped counts into one summary; pass rows of one project or of several. */
export function summarizeCounts(rows: readonly Omit<WorkCountRow, 'project_id'>[]): WorkCounts {
  const zero = <T extends string>(keys: readonly T[]) =>
    Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
  const counts: WorkCounts = {
    total: 0,
    byStatus: zero(WORK_STATUSES),
    byType: zero(WORK_TYPES),
    overdue: 0,
    percentDone: 0,
  };
  for (const row of rows) {
    counts.total += row.count;
    counts.byStatus[row.status] += row.count;
    counts.byType[row.type] += row.count;
    counts.overdue += row.overdue;
  }
  counts.percentDone = counts.total ? Math.round((counts.byStatus.done / counts.total) * 100) : 0;
  return counts;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const BOARD_SORTS = ['rank', 'priority', 'due', 'updated', 'created'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];
export const BOARD_SORT_LABELS: Record<BoardSort, string> = {
  rank: 'Board order',
  priority: 'Priority',
  due: 'Due date',
  updated: 'Recently updated',
  created: 'Newest',
};

export interface BoardQuery {
  q: string;
  type: WorkType | null;
  priority: WorkPriority | null;
  /** 'me', 'none' (unassigned), or a member's user id. */
  assignee: string | null;
  label: string | null;
  /** 'none' (in no epic) or an epic's id: its children and their sub-tasks. */
  epic: string | null;
  sort: BoardSort;
}

/** Board filters from the URL. Anything unrecognised is dropped, never trusted. */
export function parseBoardQuery(params: Record<string, string | string[] | undefined>): BoardQuery {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
  };
  const assignee = one('assignee');
  const sort = one('sort');
  const type = one('type');
  const priority = one('priority');
  const epic = one('epic');
  return {
    q: one('q').slice(0, 100),
    type: oneOf(WORK_TYPES, type) ? type : null,
    priority: oneOf(WORK_PRIORITIES, priority) ? priority : null,
    assignee:
      assignee === 'me' || assignee === 'none' || UUID.test(assignee)
        ? assignee.toLowerCase()
        : null,
    label: one('label').slice(0, MAX_TAG_LENGTH) || null,
    epic: epic === 'none' || UUID.test(epic) ? epic.toLowerCase() : null,
    sort: oneOf(BOARD_SORTS, sort) ? sort : 'rank',
  };
}

const PRIORITY_ORDER: Record<WorkPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type BoardRow = Pick<
  WorkItemRow,
  | 'id'
  | 'parent_id'
  | 'number'
  | 'title'
  | 'type'
  | 'priority'
  | 'assignee_id'
  | 'labels'
  | 'components'
  | 'due_on'
  | 'rank'
  | 'created_at'
  | 'updated_at'
>;

/**
 * Filters and orders a project's tasks for the board. Search matches the task id
 * ("CF-12"), title, labels and components, ignoring case.
 * shortcut: filters in memory over one project's tasks; move to SQL if a project passes a
 * few thousand tasks.
 */
export function applyBoardQuery<T extends BoardRow>(
  rows: readonly T[],
  query: BoardQuery,
  context: { userId: string; taskKey: string | null }
): T[] {
  const q = query.q.toLowerCase();
  const label = query.label?.toLowerCase() ?? null;
  const assignee = query.assignee === 'me' ? context.userId : query.assignee;
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id]));
  // The epic above a row: its parent when that is an epic, else its grandparent (a sub-task).
  const epicOf = (r: T): string | null => {
    if (r.type === 'epic' || !r.parent_id) return null;
    return r.type === 'subtask' ? (parentOf.get(r.parent_id) ?? null) : r.parent_id;
  };
  const filtered = rows.filter(
    (r) =>
      (!query.epic ||
        (query.epic === 'none'
          ? r.type !== 'epic' && epicOf(r) === null
          : epicOf(r) === query.epic)) &&
      (!query.type || r.type === query.type) &&
      (!query.priority || r.priority === query.priority) &&
      (!assignee || (assignee === 'none' ? r.assignee_id === null : r.assignee_id === assignee)) &&
      (!label || r.labels.some((l) => l.toLowerCase() === label)) &&
      (!q ||
        taskKeyOf(context.taskKey, r.number).toLowerCase() === q ||
        [r.title, ...r.labels, ...r.components].some((s) => s.toLowerCase().includes(q)))
  );
  const time = (d: Date) => new Date(d).getTime();
  const by: Record<BoardSort, (a: T, b: T) => number> = {
    rank: (a, b) => a.rank - b.rank,
    priority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    // Undated tasks last.
    due: (a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999'),
    updated: (a, b) => time(b.updated_at) - time(a.updated_at),
    created: (a, b) => time(b.created_at) - time(a.created_at),
  };
  return filtered.sort((a, b) => by[query.sort](a, b) || a.number - b.number);
}

let workTablesSeen = false;

/** Whether migrations 0019 and 0021 have been applied, so pages can say so instead of failing. */
export async function workTablesAvailable(): Promise<boolean> {
  if (workTablesSeen) return true;
  const [row] = await query<{ available: boolean }>(
    `select exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'work_items'
                      and column_name = 'parent_id') as available`,
    []
  );
  workTablesSeen = row?.available === true;
  return workTablesSeen;
}

export interface ProjectDetailRow {
  id: string;
  name: string;
  source_type: 'file' | 'jira';
  jira_project_key: string | null;
  description: string;
  status: ProjectStatus;
  task_key: string | null;
  created_at: Date;
}

const PROJECT_DETAIL = `id, name, source_type, jira_project_key, description, status, task_key, created_at`;

/** Every project of the tenant with its details, by name. */
export async function listProjectDetails(tenantId: TenantId): Promise<ProjectDetailRow[]> {
  return query<ProjectDetailRow>(
    `select ${PROJECT_DETAIL} from projects where tenant_id = $1 order by name`,
    [tenantId]
  );
}

/** One project, or null when it is not in this tenant (the same answer, deliberately). */
export async function getProjectDetail(
  tenantId: TenantId,
  projectId: string
): Promise<ProjectDetailRow | null> {
  if (!UUID.test(projectId)) return null;
  const [row] = await query<ProjectDetailRow>(
    `select ${PROJECT_DETAIL} from projects where tenant_id = $1 and id = $2`,
    [tenantId, projectId]
  );
  return row ?? null;
}

/** Task counts per project, grouped by status and type. Overdue: due before today, not done. */
export async function workCountRows(
  tenantId: TenantId,
  projectId?: string
): Promise<WorkCountRow[]> {
  return query<WorkCountRow>(
    `select project_id, status, type, count(*)::int as count,
            (count(*) filter (where due_on < current_date and status <> 'done'))::int as overdue
     from work_items
     where tenant_id = $1 and ($2::uuid is null or project_id = $2::uuid)
     group by project_id, status, type`,
    [tenantId, projectId ?? null]
  );
}

export interface WorkItemRow {
  id: string;
  project_id: string;
  number: number;
  type: WorkType;
  priority: WorkPriority;
  status: WorkStatus;
  title: string;
  description: string;
  acceptance_criteria: string;
  assignee_id: string | null;
  assignee_email: string | null;
  reporter_id: string | null;
  reporter_email: string | null;
  /** YYYY-MM-DD, read as text so no time zone shifts the day. */
  due_on: string | null;
  overdue: boolean;
  labels: string[];
  components: string[];
  sprint_id: string | null;
  sprint_name: string | null;
  /** Order within its board column; lower first. */
  rank: number;
  ticket_id: string | null;
  ticket_key: string | null;
  ticket_title: string | null;
  scenario_id: string | null;
  scenario_title: string | null;
  parent_id: string | null;
  parent_number: number | null;
  parent_title: string | null;
  story_points: number | null;
  created_at: Date;
  updated_at: Date;
}

// The joins resolve display names for ids already scoped to this tenant's task row.
const WORK_ITEM_SELECT = `
  select w.id, w.project_id, w.number, w.type, w.priority, w.status, w.title, w.description,
         w.acceptance_criteria, w.assignee_id, au.email as assignee_email, w.reporter_id, ru.email as reporter_email,
         w.due_on::text as due_on,
         (w.due_on is not null and w.due_on < current_date and w.status <> 'done') as overdue,
         w.labels, w.components, w.sprint_id, sp.name as sprint_name, w.rank,
         w.ticket_id, t.external_key as ticket_key, t.title as ticket_title,
         w.scenario_id, s.title as scenario_title,
         w.parent_id, pw.number as parent_number, pw.title as parent_title, w.story_points,
         w.created_at, w.updated_at
  from work_items w
  left join work_items pw on pw.id = w.parent_id and pw.tenant_id = w.tenant_id
  left join auth.users au on au.id = w.assignee_id
  left join auth.users ru on ru.id = w.reporter_id
  left join tickets t on t.id = w.ticket_id and t.tenant_id = w.tenant_id
  left join scenarios s on s.id = w.scenario_id and s.tenant_id = w.tenant_id
  left join sprints sp on sp.id = w.sprint_id and sp.tenant_id = w.tenant_id`;

/** A project's tasks, newest first. */
export async function listWorkItems(tenantId: TenantId, projectId: string): Promise<WorkItemRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     where w.tenant_id = $1 and w.project_id = $2
     order by w.number desc`,
    [tenantId, projectId]
  );
}

/**
 * A person's unfinished tasks across every project of the workspace, for Home's "Assigned to
 * me": overdue first, then by due date (undated last), then by priority.
 */
export async function listAssignedWorkItems(
  tenantId: TenantId,
  userId: string,
  limit = 50
): Promise<WorkItemRow[]> {
  if (!UUID.test(userId)) return [];
  return query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     where w.tenant_id = $1 and w.assignee_id = $2 and w.status <> 'done'
     order by (w.due_on < current_date) desc nulls last, w.due_on nulls last,
              case w.priority when 'critical' then 0 when 'high' then 1
                              when 'medium' then 2 else 3 end,
              w.updated_at desc
     limit $3`,
    [tenantId, userId, Math.min(Math.max(limit, 1), 200)]
  );
}

/** One task by its project and number, or null when it is not in this tenant. */
export async function getWorkItemByNumber(
  tenantId: TenantId,
  projectId: string,
  number: number
): Promise<WorkItemRow | null> {
  if (!UUID.test(projectId) || !Number.isSafeInteger(number) || number < 1) return null;
  const [row] = await query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     where w.tenant_id = $1 and w.project_id = $2 and w.number = $3`,
    [tenantId, projectId, number]
  );
  return row ?? null;
}

export interface WorkEventRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  item_number: number | null;
  item_title: string | null;
  actor_email: string | null;
  kind: string;
  field: string | null;
  from_value: string | null;
  to_value: string | null;
  created_at: Date;
}

/**
 * Recent activity of a project, of one task, or of the whole workspace, newest first.
 * `projectIds` keeps it to those projects; `actorId` to what one person did.
 */
export async function listWorkEvents(
  tenantId: TenantId,
  scope: {
    projectId?: string;
    workItemId?: string;
    projectIds?: string[] | null;
    actorId?: string;
  },
  limit = 30
): Promise<WorkEventRow[]> {
  if (
    (scope.projectId && !UUID.test(scope.projectId)) ||
    (scope.workItemId && !UUID.test(scope.workItemId)) ||
    (scope.actorId && !UUID.test(scope.actorId)) ||
    scope.projectIds?.some((id) => !UUID.test(id))
  ) {
    return [];
  }
  return query<WorkEventRow>(
    `select e.id, e.project_id, e.work_item_id, e.item_number,
            coalesce(w.title, e.item_title) as item_title, u.email as actor_email,
            e.kind, e.field, e.from_value, e.to_value, e.created_at
     from work_item_events e
     left join work_items w on w.id = e.work_item_id and w.tenant_id = e.tenant_id
     left join auth.users u on u.id = e.actor_id
     where e.tenant_id = $1
       and ($2::uuid is null or e.project_id = $2::uuid)
       and ($3::uuid is null or e.work_item_id = $3::uuid)
       and ($5::uuid[] is null or e.project_id = any($5::uuid[]))
       and ($6::uuid is null or e.actor_id = $6::uuid)
     order by e.created_at desc, e.id
     limit $4`,
    [
      tenantId,
      scope.projectId ?? null,
      scope.workItemId ?? null,
      Math.min(Math.max(limit, 1), 200),
      scope.projectIds ?? null,
      scope.actorId ?? null,
    ]
  );
}

export interface LinkableTicketRow {
  id: string;
  external_key: string;
  title: string;
}

/** The project's spec tickets a task can point at. */
export async function listLinkableTickets(
  tenantId: TenantId,
  projectId: string
): Promise<LinkableTicketRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<LinkableTicketRow>(
    `select id, external_key, title from tickets
     where tenant_id = $1 and project_id = $2
     order by external_key`,
    [tenantId, projectId]
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The actor's role in the project ('owner' for a workspace owner, else their project role).
 * A project they cannot see is refused with `missing`, the same words as a wrong id.
 */
async function memberRole(
  client: PoolClient,
  tenantId: TenantId,
  userId: string,
  projectId: string,
  missing = 'That project is not in this workspace.'
): Promise<Role> {
  const role = await projectRoleWith(client, tenantId, projectId, userId);
  if (!role) throw new WorkError(missing);
  return role;
}

const TASK_MISSING = 'That task is not in this workspace.';

const canManage = (role: Role) => role === 'owner' || role === 'admin';

/**
 * Refuses an assignee who is not a member, or a ticket or scenario outside the task's project.
 * A scenario brings its ticket along: with no ticket chosen the scenario's is used, and a
 * different ticket is refused. Returns the fields to store.
 */
async function resolveReferences(
  client: PoolClient,
  tenantId: TenantId,
  projectId: string,
  fields: TaskFields
): Promise<TaskFields> {
  if (fields.assigneeId) {
    if (!(await projectRoleWith(client, tenantId, projectId, fields.assigneeId))) {
      throw new WorkError('The assignee must be a member of this project.');
    }
  }
  if (fields.parentId) {
    // `for share` holds the parent's type steady until this transaction commits.
    const {
      rows: [parent],
    } = await client.query<{ type: WorkType }>(
      `select type from work_items where tenant_id = $1 and project_id = $2 and id = $3
       for share`,
      [tenantId, projectId, fields.parentId]
    );
    if (!parent) throw new WorkError('That parent task is not in this project.');
    const allowed = parentTypesFor(fields.type);
    if (!allowed.includes(parent.type)) {
      throw new WorkError(
        allowed.length === 0
          ? 'An epic cannot have a parent.'
          : `A ${WORK_TYPE_LABELS[fields.type].toLowerCase()} can only sit under ${allowed
              .map(aType)
              .join(' or ')}.`
      );
    }
  }
  let ticketId = fields.ticketId;
  if (fields.scenarioId) {
    const {
      rows: [scenario],
    } = await client.query<{ ticket_id: string }>(
      `select s.ticket_id from scenarios s
       join tickets t on t.id = s.ticket_id and t.tenant_id = s.tenant_id
       where s.tenant_id = $1 and t.project_id = $2 and s.id = $3`,
      [tenantId, projectId, fields.scenarioId]
    );
    if (!scenario) throw new WorkError('That scenario is not in this project.');
    if (ticketId && ticketId !== scenario.ticket_id) {
      throw new WorkError('That scenario belongs to a different spec ticket.');
    }
    ticketId = scenario.ticket_id;
  }
  if (ticketId) {
    const { rowCount } = await client.query(
      `select 1 from tickets where tenant_id = $1 and project_id = $2 and id = $3`,
      [tenantId, projectId, ticketId]
    );
    if (!rowCount) throw new WorkError('That ticket is not in this project.');
  }
  return { ...fields, ticketId };
}

/** Display values for an event: emails for people, ticket keys for tickets. */
async function describeChanges(
  client: PoolClient,
  tenantId: TenantId,
  changes: TaskChange[]
): Promise<TaskChange[]> {
  const ids = (field: TaskField) =>
    changes
      .filter((c) => c.field === field)
      .flatMap((c) => [c.from, c.to])
      .filter(Boolean);
  const people = ids('assigneeId');
  const tickets = ids('ticketId');
  const scenarios = ids('scenarioId');
  const parents = ids('parentId');
  const names = new Map<string, string>();
  if (parents.length) {
    const { rows } = await client.query<{ id: string; key: string }>(
      `select w.id, coalesce(p.task_key, 'TASK') || '-' || w.number as key
       from work_items w join projects p on p.id = w.project_id and p.tenant_id = w.tenant_id
       where w.tenant_id = $1 and w.id = any($2::uuid[])`,
      [tenantId, parents]
    );
    for (const r of rows) names.set(r.id, r.key);
  }
  if (people.length) {
    const { rows } = await client.query<{ id: string; email: string | null }>(
      `select id, email from auth.users where id = any($1::uuid[])`,
      [people]
    );
    for (const r of rows) names.set(r.id, r.email ?? 'a member');
  }
  if (tickets.length) {
    const { rows } = await client.query<{ id: string; external_key: string }>(
      `select id, external_key from tickets where tenant_id = $1 and id = any($2::uuid[])`,
      [tenantId, tickets]
    );
    for (const r of rows) names.set(r.id, r.external_key);
  }
  if (scenarios.length) {
    const { rows } = await client.query<{ id: string; title: string }>(
      `select id, title from scenarios where tenant_id = $1 and id = any($2::uuid[])`,
      [tenantId, scenarios]
    );
    for (const r of rows) names.set(r.id, r.title.slice(0, 120));
  }
  const show = (v: string | null) => (v === null ? null : (names.get(v) ?? v));
  return changes.map((c) =>
    c.field === 'assigneeId' ||
    c.field === 'ticketId' ||
    c.field === 'scenarioId' ||
    c.field === 'parentId'
      ? { ...c, from: show(c.from), to: show(c.to) }
      : c
  );
}

/**
 * Inbox notifications (and so emails) about a task, written in the caller's transaction. Never
 * to the actor, only to members of the workspace. Inside a savepoint, so a database without
 * migration 0020 skips the notification instead of failing the change it is about.
 */
async function notifyTask(
  client: PoolClient,
  tenantId: TenantId,
  input: {
    kind: 'task_assigned' | 'task_commented';
    itemId: string;
    projectId: string;
    number: number;
    title: string;
    actorId: string;
    recipients: readonly (string | null)[];
  }
): Promise<void> {
  const to = [
    ...new Set(input.recipients.filter((r): r is string => Boolean(r) && r !== input.actorId)),
  ];
  if (to.length === 0) return;
  await client.query('savepoint task_notify');
  try {
    await client.query(
      `insert into notifications (tenant_id, user_id, kind, payload)
       select m.tenant_id, m.user_id, $2,
              jsonb_build_object(
                'taskId', $3::text, 'projectId', $4::text, 'number', $5::int,
                'key', (select coalesce(task_key, 'TASK') from projects
                         where tenant_id = $1 and id = $4::uuid) || '-' || $5::int,
                'title', $6::text,
                'by', (select email from auth.users where id = $7::uuid))
       from memberships m
       where m.tenant_id = $1 and m.user_id = any($8::uuid[])
         and (m.role = 'owner' or exists (
               select 1 from project_members pm
               where pm.tenant_id = m.tenant_id and pm.project_id = $4::uuid
                 and pm.user_id = m.user_id))`,
      [
        tenantId,
        input.kind,
        input.itemId,
        input.projectId,
        input.number,
        input.title,
        input.actorId,
        to,
      ]
    );
    await client.query('release savepoint task_notify');
  } catch (error) {
    await client.query('rollback to savepoint task_notify');
    console.warn(
      '[work] task notification skipped:',
      error instanceof Error ? error.message : error
    );
  }
}

async function insertEvent(
  client: PoolClient,
  tenantId: TenantId,
  event: {
    projectId: string;
    workItemId: string | null;
    number: number | null;
    title: string | null;
    actorId: string;
    kind: string;
    field?: string | null;
    from?: string | null;
    to?: string | null;
  }
): Promise<void> {
  await client.query(
    `insert into work_item_events
       (tenant_id, project_id, work_item_id, item_number, item_title, actor_id, kind,
        field, from_value, to_value)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId,
      event.projectId,
      event.workItemId,
      event.number,
      event.title,
      event.actorId,
      event.kind,
      event.field ?? null,
      event.from ?? null,
      event.to ?? null,
    ]
  );
}

export interface CreatedWorkItem {
  id: string;
  projectId: string;
  number: number;
  key: string;
}

/** Creates a task in a project; the actor is its reporter. Returns its project and number. */
export async function createWorkItem(
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  raw: RawTaskInput
): Promise<CreatedWorkItem> {
  const fields = normalizeTaskInput(raw);
  if (!UUID.test(projectId)) throw new WorkError('That project is not in this workspace.');
  return tx(async (client) => {
    await memberRole(client, tenantId, actorId, projectId);
    return insertWorkItem(client, tenantId, actorId, projectId, fields);
  });
}

/** The insert behind createWorkItem, inside the caller's transaction. */
async function insertWorkItem(
  client: PoolClient,
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  input: TaskFields
): Promise<CreatedWorkItem> {
  const {
    rows: [project],
  } = await client.query<{ name: string; task_key: string | null }>(
    `select name, task_key from projects where tenant_id = $1 and id = $2`,
    [tenantId, projectId]
  );
  if (!project) throw new WorkError('That project is not in this workspace.');
  const fields = await resolveReferences(client, tenantId, projectId, input);

  // A project's first task picks its key; the tenant-wide lock keeps two projects from
  // picking the same one at once.
  let newKey: string | null = null;
  if (!project.task_key) {
    await client.query(`select pg_advisory_xact_lock(hashtext('specfix_task_key:' || $1))`, [
      tenantId,
    ]);
    const { rows: taken } = await client.query<{ task_key: string }>(
      `select task_key from projects where tenant_id = $1 and task_key is not null and id <> $2`,
      [tenantId, projectId]
    );
    const used = new Set(taken.map((r) => r.task_key));
    const base = deriveTaskKey(project.name);
    newKey = base;
    for (let n = 2; used.has(newKey); n++) newKey = `${base.slice(0, 10 - String(n).length)}${n}`;
  }

  const {
    rows: [seq],
  } = await client.query<{ task_seq: number; task_key: string }>(
    `update projects set task_seq = task_seq + 1, task_key = coalesce(task_key, $3)
       where tenant_id = $1 and id = $2
       returning task_seq, task_key`,
    [tenantId, projectId, newKey]
  );
  if (!seq) throw new WorkError('That project is not in this workspace.');

  const {
    rows: [item],
  } = await client.query<{ id: string }>(
    `insert into work_items
         (tenant_id, project_id, number, type, priority, status, title, description,
          assignee_id, reporter_id, due_on, labels, components, ticket_id, scenario_id,
          parent_id, story_points, acceptance_criteria, rank)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               (select coalesce(max(rank), 0) + 1 from work_items
                 where tenant_id = $1 and project_id = $2 and status = $6))
       returning id`,
    [
      tenantId,
      projectId,
      seq.task_seq,
      fields.type,
      fields.priority,
      fields.status,
      fields.title,
      fields.description,
      fields.assigneeId,
      actorId,
      fields.dueOn,
      fields.labels,
      fields.components,
      fields.ticketId,
      fields.scenarioId,
      fields.parentId,
      fields.storyPoints,
      fields.acceptanceCriteria,
    ]
  );
  if (!item) throw new Error('work_items insert returned no row');
  await insertEvent(client, tenantId, {
    projectId,
    workItemId: item.id,
    number: seq.task_seq,
    title: fields.title,
    actorId,
    kind: 'created',
  });
  await notifyTask(client, tenantId, {
    kind: 'task_assigned',
    itemId: item.id,
    projectId,
    number: seq.task_seq,
    title: fields.title,
    actorId,
    recipients: [fields.assigneeId],
  });
  return {
    id: item.id,
    projectId,
    number: seq.task_seq,
    key: taskKeyOf(seq.task_key, seq.task_seq),
  };
}

interface LockedItem {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  acceptance_criteria: string;
  type: WorkType;
  priority: WorkPriority;
  status: WorkStatus;
  assignee_id: string | null;
  due_on: string | null;
  labels: string[];
  components: string[];
  ticket_id: string | null;
  scenario_id: string | null;
  parent_id: string | null;
  story_points: number | null;
}

async function lockItem(
  client: PoolClient,
  tenantId: TenantId,
  itemId: string
): Promise<LockedItem> {
  if (!UUID.test(itemId)) throw new WorkError('That task is not in this workspace.');
  const {
    rows: [item],
  } = await client.query<LockedItem>(
    `select id, project_id, number, title, description, type, priority, status, assignee_id,
            due_on::text as due_on, labels, components, ticket_id, scenario_id,
            parent_id, story_points, acceptance_criteria
     from work_items where tenant_id = $1 and id = $2
     for update`,
    [tenantId, itemId]
  );
  if (!item) throw new WorkError('That task is not in this workspace.');
  return item;
}

const fieldsOf = (item: LockedItem): TaskFields => ({
  title: item.title,
  description: item.description,
  acceptanceCriteria: item.acceptance_criteria,
  type: item.type,
  priority: item.priority,
  status: item.status,
  assigneeId: item.assignee_id,
  dueOn: item.due_on,
  labels: item.labels,
  components: item.components,
  ticketId: item.ticket_id,
  scenarioId: item.scenario_id,
  parentId: item.parent_id,
  storyPoints: item.story_points,
});

/**
 * Replaces a task's fields with a submitted form and records one event per changed field.
 * Returns the changes (empty when nothing changed, and then nothing is written).
 */
export async function updateWorkItem(
  tenantId: TenantId,
  actorId: string,
  itemId: string,
  raw: RawTaskInput
): Promise<TaskChange[]> {
  const input = normalizeTaskInput(raw);
  return tx(async (client) => {
    const item = await lockItem(client, tenantId, itemId);
    await memberRole(client, tenantId, actorId, item.project_id, TASK_MISSING);
    const fields = await resolveReferences(client, tenantId, item.project_id, input);
    const changes = diffTask(fieldsOf(item), fields);
    if (changes.length === 0) return [];

    if (fields.type !== item.type) {
      // The row lock above keeps new children out while this check runs.
      const { rows: children } = await client.query<{ type: WorkType }>(
        `select distinct type from work_items where tenant_id = $1 and parent_id = $2`,
        [tenantId, item.id]
      );
      if (children.some((c) => !parentTypesFor(c.type).includes(fields.type))) {
        throw new WorkError(
          `This ${WORK_TYPE_LABELS[item.type].toLowerCase()} has child tasks that cannot sit under ${aType(fields.type)}. Move them first.`
        );
      }
    }

    const moved = fields.status !== item.status;
    await client.query(
      `update work_items
         set title = $3, description = $4, type = $5, priority = $6, status = $7,
             assignee_id = $8, due_on = $9, labels = $10, components = $11, ticket_id = $12,
             scenario_id = $15, parent_id = $16, story_points = $17,
             acceptance_criteria = $18,
             rank = case when $13 then (select coalesce(max(rank), 0) + 1 from work_items
                                         where tenant_id = $1 and project_id = $14 and status = $7)
                         else rank end,
             updated_at = now()
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        item.id,
        fields.title,
        fields.description,
        fields.type,
        fields.priority,
        fields.status,
        fields.assigneeId,
        fields.dueOn,
        fields.labels,
        fields.components,
        fields.ticketId,
        moved,
        item.project_id,
        fields.scenarioId,
        fields.parentId,
        fields.storyPoints,
        fields.acceptanceCriteria,
      ]
    );
    for (const change of await describeChanges(client, tenantId, changes)) {
      await insertEvent(client, tenantId, {
        projectId: item.project_id,
        workItemId: item.id,
        number: item.number,
        title: fields.title,
        actorId,
        kind: 'updated',
        field: change.field,
        from: change.from,
        to: change.to,
      });
    }
    if (fields.assigneeId !== item.assignee_id) {
      await notifyTask(client, tenantId, {
        kind: 'task_assigned',
        itemId: item.id,
        projectId: item.project_id,
        number: item.number,
        title: fields.title,
        actorId,
        recipients: [fields.assigneeId],
      });
    }
    return changes;
  });
}

/**
 * Moves a task on the board: into `status`, placed just before `beforeId` when that task is in
 * the same column, else at the column's end. A status change records an event; reordering
 * within a column does not.
 */
export async function moveWorkItem(
  tenantId: TenantId,
  actorId: string,
  itemId: string,
  input: { status: string; beforeId?: string | null }
): Promise<{ projectId: string; number: number; status: WorkStatus; moved: boolean }> {
  if (!oneOf(WORK_STATUSES, input.status)) throw new WorkError('Choose one of the board columns.');
  const status = input.status;
  const beforeId =
    input.beforeId && UUID.test(input.beforeId) && input.beforeId !== itemId
      ? input.beforeId
      : null;

  return tx(async (client) => {
    const item = await lockItem(client, tenantId, itemId);
    await memberRole(client, tenantId, actorId, item.project_id, TASK_MISSING);
    const column: unknown[] = [tenantId, item.project_id, status, item.id];

    const rankFor = async (): Promise<number | null> => {
      if (!beforeId) return null;
      const {
        rows: [before],
      } = await client.query<{ rank: number }>(
        `select rank from work_items
         where tenant_id = $1 and project_id = $2 and status = $3 and id <> $4 and id = $5`,
        [...column, beforeId]
      );
      if (!before) return null;
      const {
        rows: [prev],
      } = await client.query<{ rank: number | null }>(
        `select max(rank) as rank from work_items
         where tenant_id = $1 and project_id = $2 and status = $3 and id <> $4 and rank < $5`,
        [...column, before.rank]
      );
      const low = prev?.rank ?? before.rank - 1;
      const mid = (low + before.rank) / 2;
      // Repeated halving eventually runs out of float precision; then the caller renumbers.
      return mid > low && mid < before.rank ? mid : Number.NaN;
    };

    let rank = await rankFor();
    if (Number.isNaN(rank)) {
      await client.query(
        `update work_items w set rank = o.n
         from (select id, row_number() over (order by rank, number) as n
               from work_items
               where tenant_id = $1 and project_id = $2 and status = $3 and id <> $4) o
         where w.id = o.id`,
        column
      );
      rank = await rankFor();
    }
    if (rank === null || Number.isNaN(rank)) {
      const {
        rows: [end],
      } = await client.query<{ rank: number }>(
        `select coalesce(max(rank), 0) + 1 as rank from work_items
         where tenant_id = $1 and project_id = $2 and status = $3 and id <> $4`,
        column
      );
      rank = end!.rank;
    }

    const moved = status !== item.status;
    await client.query(
      `update work_items
         set status = $3, rank = $4, updated_at = case when $5 then now() else updated_at end
       where tenant_id = $1 and id = $2`,
      [tenantId, item.id, status, rank, moved]
    );
    if (moved) {
      await insertEvent(client, tenantId, {
        projectId: item.project_id,
        workItemId: item.id,
        number: item.number,
        title: item.title,
        actorId,
        kind: 'updated',
        field: 'status',
        from: item.status,
        to: status,
      });
    }
    return { projectId: item.project_id, number: item.number, status, moved };
  });
}

/** Deletes a task (owners and admins only). Its activity stays, marked as deleted. */
export async function deleteWorkItem(
  tenantId: TenantId,
  actorId: string,
  itemId: string
): Promise<{ projectId: string; number: number; storagePaths: string[] }> {
  return tx(async (client) => {
    const item = await lockItem(client, tenantId, itemId);
    if (!canManage(await memberRole(client, tenantId, actorId, item.project_id, TASK_MISSING))) {
      throw new WorkError('Only owners and admins can delete tasks.');
    }
    // The rows go with the task (on delete cascade); the caller removes the stored files.
    const { rows: files } = await client.query<{ storage_path: string }>(
      `select storage_path from work_item_attachments where tenant_id = $1 and work_item_id = $2`,
      [tenantId, item.id]
    );
    await insertEvent(client, tenantId, {
      projectId: item.project_id,
      workItemId: item.id,
      number: item.number,
      title: item.title,
      actorId,
      kind: 'deleted',
    });
    await client.query(`delete from work_items where tenant_id = $1 and id = $2`, [
      tenantId,
      item.id,
    ]);
    return {
      projectId: item.project_id,
      number: item.number,
      storagePaths: files.map((f) => f.storage_path),
    };
  });
}

/** Changes a project's description and task key (owners and admins only). */
export async function updateProjectDetails(
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  input: { description: string; taskKey: string }
): Promise<void> {
  const description = input.description.replace(/\r\n/g, '\n').trim();
  if (description.length > 5000) {
    throw new WorkError('A project description can be at most 5,000 characters.');
  }
  const taskKey = input.taskKey.trim() ? normalizeTaskKey(input.taskKey) : null;
  if (!UUID.test(projectId)) throw new WorkError('That project is not in this workspace.');

  await tx(async (client) => {
    if (!canManage(await memberRole(client, tenantId, actorId, projectId))) {
      throw new WorkError('Only owners and admins can change project details.');
    }
    await client.query(`select pg_advisory_xact_lock(hashtext('specfix_task_key:' || $1))`, [
      tenantId,
    ]);
    if (taskKey) {
      const { rowCount } = await client.query(
        `select 1 from projects where tenant_id = $1 and task_key = $2 and id <> $3`,
        [tenantId, taskKey, projectId]
      );
      if (rowCount) throw new WorkError(`Another project already uses the key ${taskKey}.`);
    }
    const { rowCount } = await client.query(
      `update projects
         set description = $3, task_key = coalesce($4, task_key)
       where tenant_id = $1 and id = $2`,
      [tenantId, projectId, description, taskKey]
    );
    if (!rowCount) throw new WorkError('That project is not in this workspace.');
  });
}

/** Marks a project running, on hold, completed or archived. Owners only, and any time. */
export async function setProjectStatus(
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  status: string
): Promise<void> {
  if (!oneOf(PROJECT_STATUSES, status)) throw new WorkError('Choose a project status.');
  if (!UUID.test(projectId)) throw new WorkError('That project is not in this workspace.');
  await tx(async (client) => {
    if ((await memberRole(client, tenantId, actorId, projectId)) !== 'owner') {
      throw new WorkError('Only owners can change a project’s status.');
    }
    await client.query(`update projects set status = $3 where tenant_id = $1 and id = $2`, [
      tenantId,
      projectId,
      status,
    ]);
  });
}

// ---------------------------------------------------------------------------
// Links to specs: a ticket's tasks, the scenarios a task can point at, bugs from CI
// ---------------------------------------------------------------------------

/** Tasks that point at a spec ticket, for its Specs tab. */
export async function listWorkItemsForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<WorkItemRow[]> {
  if (!UUID.test(ticketId)) return [];
  return query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     where w.tenant_id = $1 and w.ticket_id = $2
     order by w.number desc`,
    [tenantId, ticketId]
  );
}

export interface LinkableScenarioRow {
  id: string;
  title: string;
  status: string;
  ticket_id: string;
  ticket_key: string;
}

/** The project's scenarios a task can point at (all but dismissed ones). */
export async function listLinkableScenarios(
  tenantId: TenantId,
  projectId: string
): Promise<LinkableScenarioRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<LinkableScenarioRow>(
    `select s.id, s.title, s.status, s.ticket_id, t.external_key as ticket_key
     from scenarios s
     join tickets t on t.id = s.ticket_id and t.tenant_id = s.tenant_id
     where s.tenant_id = $1 and t.project_id = $2 and s.status <> 'dismissed'
     order by t.external_key, s.created_at`,
    [tenantId, projectId]
  );
}

export interface BugSource {
  ticketKey: string;
  scenarioTitle: string;
  result: {
    status: string;
    error: string | null;
    branch: string | null;
    commit_sha: string | null;
    received_at: Date;
  } | null;
}

const MAX_BUG_ERROR = 4000;

/** The description of a bug filed from a scenario: where it came from and the CI error. */
export function buildBugDescription(source: BugSource): string {
  const lines = [
    `Filed from scenario "${source.scenarioTitle}" on spec ticket ${source.ticketKey}.`,
  ];
  const r = source.result;
  if (r) {
    const where = [
      r.branch ? `on ${r.branch}` : null,
      r.commit_sha ? `at ${r.commit_sha.slice(0, 7)}` : null,
    ].filter(Boolean);
    lines.push(
      '',
      `Latest default-branch CI result: ${r.status}${where.length ? ` ${where.join(' ')}` : ''} (${new Date(r.received_at).toISOString().slice(0, 16).replace('T', ' ')} UTC).`
    );
    if (r.error) {
      const error =
        r.error.length > MAX_BUG_ERROR
          ? `${r.error.slice(0, MAX_BUG_ERROR)}\n…(truncated)`
          : r.error;
      lines.push('', 'Error:', error);
    }
  } else {
    lines.push('', 'No CI result has been reported for this scenario yet.');
  }
  return lines.join('\n');
}

/**
 * Files a high-priority bug for a scenario, linked to it and its ticket. While an open bug
 * already points at the scenario that one is returned instead (`existing`), so repeated or
 * concurrent clicks file one bug.
 */
export async function fileBugFromScenario(
  tenantId: TenantId,
  actorId: string,
  scenarioId: string
): Promise<CreatedWorkItem & { existing: boolean }> {
  if (!UUID.test(scenarioId)) throw new WorkError('That scenario is not in this workspace.');
  return tx(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('specfix_scenario_bug:' || $1))`, [
      scenarioId,
    ]);
    const {
      rows: [scenario],
    } = await client.query<{ title: string; project_id: string; external_key: string }>(
      `select s.title, t.project_id, t.external_key
       from scenarios s
       join tickets t on t.id = s.ticket_id and t.tenant_id = s.tenant_id
       where s.tenant_id = $1 and s.id = $2`,
      [tenantId, scenarioId]
    );
    if (!scenario) throw new WorkError('That scenario is not in this workspace.');
    await memberRole(
      client,
      tenantId,
      actorId,
      scenario.project_id,
      'That scenario is not in this workspace.'
    );

    const {
      rows: [open],
    } = await client.query<{ id: string; number: number; task_key: string | null }>(
      `select w.id, w.number, p.task_key
       from work_items w
       join projects p on p.id = w.project_id and p.tenant_id = w.tenant_id
       where w.tenant_id = $1 and w.scenario_id = $2 and w.type = 'bug' and w.status <> 'done'
       order by w.number
       limit 1`,
      [tenantId, scenarioId]
    );
    if (open) {
      return {
        id: open.id,
        projectId: scenario.project_id,
        number: open.number,
        key: taskKeyOf(open.task_key, open.number),
        existing: true,
      };
    }

    const {
      rows: [result],
    } = await client.query<NonNullable<BugSource['result']>>(
      `select r.status, r.error, cr.branch, cr.commit_sha, cr.received_at
       from ci_results r
       join ci_runs cr on cr.id = r.ci_run_id and cr.tenant_id = r.tenant_id
       where r.tenant_id = $1 and r.scenario_id = $2 and cr.on_default_branch
       order by cr.received_at desc
       limit 1`,
      [tenantId, scenarioId]
    );
    const fields = normalizeTaskInput({
      title: `Failing scenario: ${scenario.title}`.slice(0, 200),
      description: buildBugDescription({
        ticketKey: scenario.external_key,
        scenarioTitle: scenario.title,
        result: result ?? null,
      }),
      type: 'bug',
      priority: 'high',
      scenarioId,
    });
    const created = await insertWorkItem(client, tenantId, actorId, scenario.project_id, fields);
    return { ...created, existing: false };
  });
}

// ---------------------------------------------------------------------------
// Collaboration: comments and links between tasks
// ---------------------------------------------------------------------------

export interface WorkCommentRow {
  id: string;
  author_id: string | null;
  author_email: string | null;
  body: string;
  created_at: Date;
}

/** A task's comments, oldest first. */
export async function listWorkComments(
  tenantId: TenantId,
  itemId: string
): Promise<WorkCommentRow[]> {
  if (!UUID.test(itemId)) return [];
  return query<WorkCommentRow>(
    `select c.id, c.author_id, u.email as author_email, c.body, c.created_at
     from work_item_comments c
     left join auth.users u on u.id = c.author_id
     where c.tenant_id = $1 and c.work_item_id = $2
     order by c.created_at, c.id`,
    [tenantId, itemId]
  );
}

/** A comment as typed: line endings normalised, 1–10,000 characters. */
export function normalizeComment(raw: string | null | undefined): string {
  const body = (raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new WorkError('Write something before posting the comment.');
  if (body.length > 10000) throw new WorkError('A comment can be at most 10,000 characters.');
  return body;
}

/** Adds a comment by any member, and a "commented" event. */
export async function addWorkComment(
  tenantId: TenantId,
  actorId: string,
  itemId: string,
  rawBody: string | null | undefined
): Promise<{ id: string; projectId: string; number: number }> {
  const body = normalizeComment(rawBody);
  return tx(async (client) => {
    const item = await lockItem(client, tenantId, itemId);
    await memberRole(client, tenantId, actorId, item.project_id, TASK_MISSING);
    const {
      rows: [comment],
    } = await client.query<{ id: string }>(
      `insert into work_item_comments (tenant_id, work_item_id, author_id, body)
       values ($1, $2, $3, $4) returning id`,
      [tenantId, item.id, actorId, body]
    );
    if (!comment) throw new Error('work_item_comments insert returned no row');
    await insertEvent(client, tenantId, {
      projectId: item.project_id,
      workItemId: item.id,
      number: item.number,
      title: item.title,
      actorId,
      kind: 'commented',
    });
    const {
      rows: [people],
    } = await client.query<{ reporter_id: string | null }>(
      `select reporter_id from work_items where tenant_id = $1 and id = $2`,
      [tenantId, item.id]
    );
    await notifyTask(client, tenantId, {
      kind: 'task_commented',
      itemId: item.id,
      projectId: item.project_id,
      number: item.number,
      title: item.title,
      actorId,
      recipients: [item.assignee_id, people?.reporter_id ?? null],
    });
    // @mentions reach anyone else named; the assignee and reporter were told above.
    if (parseMentions(body).length > 0) {
      const {
        rows: [project],
      } = await client.query<{ task_key: string | null }>(
        `select task_key from projects where tenant_id = $1 and id = $2`,
        [tenantId, item.project_id]
      );
      await notifyMentions(client, tenantId, {
        body,
        actorId,
        projectId: item.project_id,
        payload: {
          taskId: item.id,
          projectId: item.project_id,
          number: item.number,
          key: taskKeyOf(project?.task_key ?? null, item.number),
          title: item.title,
        },
        skip: [item.assignee_id, people?.reporter_id ?? null],
      });
    }
    return { id: comment.id, projectId: item.project_id, number: item.number };
  });
}

/** Deletes a comment: its author, or an owner or admin. */
export async function deleteWorkComment(
  tenantId: TenantId,
  actorId: string,
  commentId: string
): Promise<{ projectId: string; number: number }> {
  if (!UUID.test(commentId)) throw new WorkError('That comment is not in this workspace.');
  return tx(async (client) => {
    const {
      rows: [comment],
    } = await client.query<{ author_id: string | null; project_id: string; number: number }>(
      `select c.author_id, w.project_id, w.number
       from work_item_comments c
       join work_items w on w.id = c.work_item_id and w.tenant_id = c.tenant_id
       where c.tenant_id = $1 and c.id = $2
       for update of c`,
      [tenantId, commentId]
    );
    if (!comment) throw new WorkError('That comment is not in this workspace.');
    const role = await memberRole(
      client,
      tenantId,
      actorId,
      comment.project_id,
      'That comment is not in this workspace.'
    );
    if (comment.author_id !== actorId && !canManage(role)) {
      throw new WorkError('Only its author, an owner or an admin can delete a comment.');
    }
    await client.query(`delete from work_item_comments where tenant_id = $1 and id = $2`, [
      tenantId,
      commentId,
    ]);
    return { projectId: comment.project_id, number: comment.number };
  });
}

export const LINK_KINDS = ['relates', 'blocks', 'duplicates'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** How a link reads from one side: "blocks CF-3" from its source, "is blocked by CF-2" from its target. */
export function linkLabel(kind: LinkKind, direction: 'out' | 'in'): string {
  if (kind === 'relates') return 'relates to';
  if (kind === 'blocks') return direction === 'out' ? 'blocks' : 'is blocked by';
  return direction === 'out' ? 'duplicates' : 'is duplicated by';
}

export interface WorkLinkRow {
  kind: LinkKind;
  direction: 'out' | 'in';
  from_id: string;
  to_id: string;
  other_number: number;
  other_title: string;
  other_status: WorkStatus;
}

/** Both directions of a task's links, with the other task's number, title and status. */
export async function listWorkLinks(tenantId: TenantId, itemId: string): Promise<WorkLinkRow[]> {
  if (!UUID.test(itemId)) return [];
  return query<WorkLinkRow>(
    `select l.kind, case when l.from_id = $2 then 'out' else 'in' end as direction,
            l.from_id, l.to_id, o.number as other_number, o.title as other_title,
            o.status as other_status
     from work_item_links l
     join work_items o
       on o.tenant_id = l.tenant_id
      and o.id = case when l.from_id = $2 then l.to_id else l.from_id end
     where l.tenant_id = $1 and (l.from_id = $2 or l.to_id = $2)
     order by l.kind, o.number`,
    [tenantId, itemId]
  );
}

/** Links two tasks of one project. Linking twice (or "relates" both ways) is a no-op. */
export async function addWorkLink(
  tenantId: TenantId,
  actorId: string,
  input: { fromId: string; toId: string; kind: string }
): Promise<{ added: boolean }> {
  if (!oneOf(LINK_KINDS, input.kind)) throw new WorkError('Choose how the tasks are linked.');
  const kind = input.kind;
  if (!UUID.test(input.toId)) throw new WorkError('Choose a task to link to.');
  if (input.fromId === input.toId) throw new WorkError('A task cannot be linked to itself.');
  return tx(async (client) => {
    const from = await lockItem(client, tenantId, input.fromId);
    await memberRole(client, tenantId, actorId, from.project_id, TASK_MISSING);
    const {
      rows: [to],
    } = await client.query<{ id: string; number: number; task_key: string | null }>(
      `select w.id, w.number, p.task_key
       from work_items w
       join projects p on p.id = w.project_id and p.tenant_id = w.tenant_id
       where w.tenant_id = $1 and w.project_id = $2 and w.id = $3`,
      [tenantId, from.project_id, input.toId]
    );
    if (!to) throw new WorkError('That task is not in this project.');
    if (kind === 'relates') {
      const { rowCount } = await client.query(
        `select 1 from work_item_links
         where tenant_id = $1 and from_id = $2 and to_id = $3 and kind = 'relates'`,
        [tenantId, to.id, from.id]
      );
      if (rowCount) return { added: false };
    }
    const { rowCount } = await client.query(
      `insert into work_item_links (tenant_id, from_id, to_id, kind, created_by)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
      [tenantId, from.id, to.id, kind, actorId]
    );
    if (!rowCount) return { added: false };
    await insertEvent(client, tenantId, {
      projectId: from.project_id,
      workItemId: from.id,
      number: from.number,
      title: from.title,
      actorId,
      kind: 'linked',
      field: kind,
      to: taskKeyOf(to.task_key, to.number),
    });
    return { added: true };
  });
}

/** Removes one link, by its source, target and kind exactly as listed. */
export async function removeWorkLink(
  tenantId: TenantId,
  actorId: string,
  input: { fromId: string; toId: string; kind: string }
): Promise<{ removed: boolean }> {
  if (!oneOf(LINK_KINDS, input.kind) || !UUID.test(input.fromId) || !UUID.test(input.toId)) {
    throw new WorkError('That link is not in this workspace.');
  }
  return tx(async (client) => {
    const {
      rows: [owner],
    } = await client.query<{ project_id: string }>(
      `select project_id from work_items where tenant_id = $1 and id = $2`,
      [tenantId, input.fromId]
    );
    if (!owner) return { removed: false };
    await memberRole(client, tenantId, actorId, owner.project_id, TASK_MISSING);
    const {
      rows: [gone],
    } = await client.query<{ to_id: string }>(
      `delete from work_item_links
       where tenant_id = $1 and from_id = $2 and to_id = $3 and kind = $4
       returning to_id`,
      [tenantId, input.fromId, input.toId, input.kind]
    );
    if (!gone) return { removed: false };
    const {
      rows: [pair],
    } = await client.query<{
      project_id: string;
      number: number;
      title: string;
      to_number: number;
      task_key: string | null;
    }>(
      `select f.project_id, f.number, f.title, t.number as to_number, p.task_key
       from work_items f
       join work_items t on t.id = $3 and t.tenant_id = f.tenant_id
       join projects p on p.id = f.project_id and p.tenant_id = f.tenant_id
       where f.tenant_id = $1 and f.id = $2`,
      [tenantId, input.fromId, input.toId]
    );
    if (pair) {
      await insertEvent(client, tenantId, {
        projectId: pair.project_id,
        workItemId: input.fromId,
        number: pair.number,
        title: pair.title,
        actorId,
        kind: 'unlinked',
        field: input.kind,
        to: taskKeyOf(pair.task_key, pair.to_number),
      });
    }
    return { removed: true };
  });
}

// ---------------------------------------------------------------------------
// Sprints
//
// A project plans work in sprints: planned → active → completed, at most one active at a
// time (enforced by the sprints_one_active index as well as here). Creating, editing,
// starting and completing a sprint is for owners and admins; any member moves tasks
// between the backlog and a sprint that is not completed. Completing a sprint sends its
// unfinished tasks back to the backlog; its done tasks stay with it as its record.
// ---------------------------------------------------------------------------

export const SPRINT_STATUSES = ['planned', 'active', 'completed'] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

export interface SprintFields {
  name: string;
  goal: string;
  startsOn: string | null;
  endsOn: string | null;
}

/** Validates a sprint form: a name of 1–100 characters, an optional goal and dates in order. */
export function normalizeSprintInput(raw: {
  name?: string | null;
  goal?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}): SprintFields {
  const name = (raw.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new WorkError('A sprint needs a name.');
  if (name.length > 100) throw new WorkError('A sprint name can be at most 100 characters.');
  const goal = (raw.goal ?? '').replace(/\r\n/g, '\n').trim();
  if (goal.length > 1000) throw new WorkError('A sprint goal can be at most 1,000 characters.');
  const startsOn = parseDueDate(raw.startsOn, 'start date');
  const endsOn = parseDueDate(raw.endsOn, 'end date');
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new WorkError('A sprint cannot end before it starts.');
  }
  return { name, goal, startsOn, endsOn };
}

export interface SprintRow {
  id: string;
  project_id: string;
  name: string;
  goal: string;
  starts_on: string | null;
  ends_on: string | null;
  status: SprintStatus;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

const SPRINT_SELECT = `id, project_id, name, goal, starts_on::text as starts_on,
  ends_on::text as ends_on, status, started_at, completed_at, created_at`;

/** A project's sprints: the active one, then planned in creation order, then completed, newest first. */
export async function listSprints(tenantId: TenantId, projectId: string): Promise<SprintRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<SprintRow>(
    `select ${SPRINT_SELECT} from sprints
     where tenant_id = $1 and project_id = $2
     order by case status when 'active' then 0 when 'planned' then 1 else 2 end,
              case when status = 'completed' then completed_at end desc nulls last,
              created_at`,
    [tenantId, projectId]
  );
}

export interface SprintCountRow {
  sprint_id: string;
  status: WorkStatus;
  type: WorkType;
  count: number;
  overdue: number;
}

/** Task counts per sprint of a project, in the shape summarizeCounts folds. */
export async function sprintCountRows(
  tenantId: TenantId,
  projectId: string
): Promise<SprintCountRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<SprintCountRow>(
    `select sprint_id, status, type, count(*)::int as count,
            (count(*) filter (where due_on < current_date and status <> 'done'))::int as overdue
     from work_items
     where tenant_id = $1 and project_id = $2 and sprint_id is not null
     group by sprint_id, status, type`,
    [tenantId, projectId]
  );
}

async function requireManager(
  client: PoolClient,
  tenantId: TenantId,
  actorId: string,
  projectId: string
) {
  if (!canManage(await memberRole(client, tenantId, actorId, projectId))) {
    throw new WorkError('Only owners and admins can plan sprints.');
  }
}

async function lockSprint(client: PoolClient, tenantId: TenantId, sprintId: string) {
  if (!UUID.test(sprintId)) throw new WorkError('That sprint is not in this workspace.');
  const {
    rows: [sprint],
  } = await client.query<{
    id: string;
    project_id: string;
    name: string;
    status: SprintStatus;
    starts_on: string | null;
  }>(
    `select id, project_id, name, status, starts_on::text as starts_on
     from sprints where tenant_id = $1 and id = $2
     for update`,
    [tenantId, sprintId]
  );
  if (!sprint) throw new WorkError('That sprint is not in this workspace.');
  return sprint;
}

const sprintEvent = (
  projectId: string,
  actorId: string,
  kind: string,
  name: string,
  to?: string
) => ({
  projectId,
  workItemId: null,
  number: null,
  title: name,
  actorId,
  kind,
  to: to ?? null,
});

/** Adds a planned sprint to a project (owners and admins). */
export async function createSprint(
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  raw: Parameters<typeof normalizeSprintInput>[0]
): Promise<{ id: string }> {
  const fields = normalizeSprintInput(raw);
  if (!UUID.test(projectId)) throw new WorkError('That project is not in this workspace.');
  return tx(async (client) => {
    await requireManager(client, tenantId, actorId, projectId);
    const { rowCount } = await client.query(
      `select 1 from projects where tenant_id = $1 and id = $2`,
      [tenantId, projectId]
    );
    if (!rowCount) throw new WorkError('That project is not in this workspace.');
    const {
      rows: [sprint],
    } = await client.query<{ id: string }>(
      `insert into sprints (tenant_id, project_id, name, goal, starts_on, ends_on)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [tenantId, projectId, fields.name, fields.goal, fields.startsOn, fields.endsOn]
    );
    if (!sprint) throw new Error('sprints insert returned no row');
    await insertEvent(
      client,
      tenantId,
      sprintEvent(projectId, actorId, 'sprint_created', fields.name)
    );
    return sprint;
  });
}

/** Changes a sprint that is not completed (owners and admins). */
export async function updateSprint(
  tenantId: TenantId,
  actorId: string,
  sprintId: string,
  raw: Parameters<typeof normalizeSprintInput>[0]
): Promise<void> {
  const fields = normalizeSprintInput(raw);
  await tx(async (client) => {
    const sprint = await lockSprint(client, tenantId, sprintId);
    await requireManager(client, tenantId, actorId, sprint.project_id);
    if (sprint.status === 'completed') throw new WorkError('A completed sprint cannot be changed.');
    await client.query(
      `update sprints set name = $3, goal = $4, starts_on = $5, ends_on = $6
       where tenant_id = $1 and id = $2`,
      [tenantId, sprint.id, fields.name, fields.goal, fields.startsOn, fields.endsOn]
    );
    await insertEvent(
      client,
      tenantId,
      sprintEvent(sprint.project_id, actorId, 'sprint_updated', fields.name)
    );
  });
}

const ONE_ACTIVE =
  'This project already has an active sprint. Complete it before starting another.';

/** Starts a planned sprint; its start date defaults to today. One active sprint per project. */
export async function startSprint(
  tenantId: TenantId,
  actorId: string,
  sprintId: string
): Promise<void> {
  try {
    await tx(async (client) => {
      const sprint = await lockSprint(client, tenantId, sprintId);
      await requireManager(client, tenantId, actorId, sprint.project_id);
      if (sprint.status !== 'planned') throw new WorkError('Only a planned sprint can be started.');
      const { rowCount } = await client.query(
        `select 1 from sprints where tenant_id = $1 and project_id = $2 and status = 'active'`,
        [tenantId, sprint.project_id]
      );
      if (rowCount) throw new WorkError(ONE_ACTIVE);
      await client.query(
        `update sprints
           set status = 'active', started_at = now(), starts_on = coalesce(starts_on, current_date)
         where tenant_id = $1 and id = $2`,
        [tenantId, sprint.id]
      );
      await insertEvent(
        client,
        tenantId,
        sprintEvent(sprint.project_id, actorId, 'sprint_started', sprint.name)
      );
    });
  } catch (error) {
    // Two sprints started at once: the index lets one through and refuses the other.
    if ((error as { code?: string }).code === '23505') throw new WorkError(ONE_ACTIVE);
    throw error;
  }
}

/**
 * Completes the active sprint. Its unfinished tasks go back to the backlog (and are counted);
 * its done tasks stay with it.
 */
export async function completeSprint(
  tenantId: TenantId,
  actorId: string,
  sprintId: string
): Promise<{ done: number; returned: number }> {
  return tx(async (client) => {
    const sprint = await lockSprint(client, tenantId, sprintId);
    await requireManager(client, tenantId, actorId, sprint.project_id);
    if (sprint.status !== 'active') throw new WorkError('Only the active sprint can be completed.');
    const { rows: returnedRows } = await client.query<{
      id: string;
      number: number;
      title: string;
    }>(
      `update work_items set sprint_id = null, updated_at = now()
       where tenant_id = $1 and sprint_id = $2 and status <> 'done'
       returning id, number, title`,
      [tenantId, sprint.id]
    );
    for (const task of returnedRows) {
      await insertEvent(client, tenantId, {
        projectId: sprint.project_id,
        workItemId: task.id,
        number: task.number,
        title: task.title,
        actorId,
        kind: 'updated',
        field: 'sprint',
        from: sprint.name,
        to: 'Backlog',
      });
    }
    const returned = returnedRows.length;
    const {
      rows: [done],
    } = await client.query<{ n: number }>(
      `select count(*)::int as n from work_items where tenant_id = $1 and sprint_id = $2`,
      [tenantId, sprint.id]
    );
    await client.query(
      `update sprints set status = 'completed', completed_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, sprint.id]
    );
    const result = { done: done?.n ?? 0, returned };
    await insertEvent(
      client,
      tenantId,
      sprintEvent(
        sprint.project_id,
        actorId,
        'sprint_completed',
        sprint.name,
        `${result.done} done, ${result.returned} back to the backlog`
      )
    );
    return result;
  });
}

/**
 * Puts a task in a sprint of its project that is not completed, or (null) back in the backlog.
 * Any member may; the change is recorded on the task.
 */
export async function setWorkItemSprint(
  tenantId: TenantId,
  actorId: string,
  itemId: string,
  sprintId: string | null
): Promise<{ projectId: string; changed: boolean }> {
  return tx(async (client) => {
    const item = await lockItem(client, tenantId, itemId);
    await memberRole(client, tenantId, actorId, item.project_id, TASK_MISSING);
    let target: { id: string; name: string } | null = null;
    if (sprintId) {
      if (!UUID.test(sprintId)) throw new WorkError('That sprint is not in this project.');
      const {
        rows: [sprint],
      } = await client.query<{ id: string; name: string; status: SprintStatus }>(
        `select id, name, status from sprints where tenant_id = $1 and project_id = $2 and id = $3`,
        [tenantId, item.project_id, sprintId]
      );
      if (!sprint) throw new WorkError('That sprint is not in this project.');
      if (sprint.status === 'completed') {
        throw new WorkError('Tasks cannot be added to a completed sprint.');
      }
      target = sprint;
    }
    const {
      rows: [current],
    } = await client.query<{ sprint_id: string | null; name: string | null }>(
      `select w.sprint_id, sp.name from work_items w
       left join sprints sp on sp.id = w.sprint_id and sp.tenant_id = w.tenant_id
       where w.tenant_id = $1 and w.id = $2`,
      [tenantId, item.id]
    );
    if ((current?.sprint_id ?? null) === (target?.id ?? null)) {
      return { projectId: item.project_id, changed: false };
    }
    await client.query(
      `update work_items set sprint_id = $3, updated_at = now() where tenant_id = $1 and id = $2`,
      [tenantId, item.id, target?.id ?? null]
    );
    await insertEvent(client, tenantId, {
      projectId: item.project_id,
      workItemId: item.id,
      number: item.number,
      title: item.title,
      actorId,
      kind: 'updated',
      field: 'sprint',
      from: current?.name ?? 'Backlog',
      to: target?.name ?? 'Backlog',
    });
    return { projectId: item.project_id, changed: true };
  });
}

export interface SprintVelocity {
  sprintId: string;
  name: string;
  points: number;
  tasks: number;
}

/**
 * Story points and tasks finished in each completed sprint, oldest first, the last `limit`.
 * Completing a sprint returns its unfinished tasks to the backlog, so every task still in a
 * completed sprint is one it finished.
 */
export function sprintVelocity(
  sprints: readonly Pick<SprintRow, 'id' | 'name' | 'status' | 'completed_at'>[],
  tasks: readonly Pick<WorkItemRow, 'sprint_id' | 'story_points'>[],
  limit = 8
): SprintVelocity[] {
  return sprints
    .filter((s) => s.status === 'completed' && s.completed_at)
    .sort((a, b) => new Date(a.completed_at!).getTime() - new Date(b.completed_at!).getTime())
    .slice(-limit)
    .map((s) => {
      const done = tasks.filter((t) => t.sprint_id === s.id);
      return {
        sprintId: s.id,
        name: s.name,
        points: done.reduce((n, t) => n + (t.story_points ?? 0), 0),
        tasks: done.length,
      };
    });
}

export interface ActiveSprintSummaryRow {
  id: string;
  name: string;
  project_id: string;
  project_name: string;
  ends_on: string | null;
  total: number;
  done: number;
}

/** Each active sprint with its done and total task counts, for one project or the workspace. */
export async function activeSprintSummaries(
  tenantId: TenantId,
  projectId?: string
): Promise<ActiveSprintSummaryRow[]> {
  if (projectId && !UUID.test(projectId)) return [];
  return query<ActiveSprintSummaryRow>(
    `select sp.id, sp.name, sp.project_id, p.name as project_name, sp.ends_on::text as ends_on,
            count(w.id)::int as total,
            (count(w.id) filter (where w.status = 'done'))::int as done
     from sprints sp
     join projects p on p.id = sp.project_id and p.tenant_id = sp.tenant_id
     left join work_items w on w.sprint_id = sp.id and w.tenant_id = sp.tenant_id
     where sp.tenant_id = $1 and sp.status = 'active'
       and ($2::uuid is null or sp.project_id = $2::uuid)
     group by sp.id, p.name
     order by p.name`,
    [tenantId, projectId ?? null]
  );
}

// ---------------------------------------------------------------------------
// Charts: weekly throughput and sprint burndown, counted from the activity log
// ---------------------------------------------------------------------------

export interface WeeklyThroughputRow {
  /** Monday of the week (UTC), YYYY-MM-DD. */
  week: string;
  created: number;
  completed: number;
}

/**
 * Tasks created and tasks moved to Done per week, for the last `weeks` weeks including this one.
 * Read from the activity log, so a task deleted later still counts in the week it was made.
 */
export async function weeklyThroughput(
  tenantId: TenantId,
  projectId: string,
  weeks = 12
): Promise<WeeklyThroughputRow[]> {
  if (!UUID.test(projectId)) return [];
  const span = Math.min(Math.max(Math.trunc(weeks), 1), 52);
  return query<WeeklyThroughputRow>(
    `with weeks as (
       select generate_series(date_trunc('week', now()) - make_interval(weeks => $3 - 1),
                              date_trunc('week', now()), interval '1 week') as week
     ),
     counted as (
       select date_trunc('week', created_at) as week,
              count(*) filter (where kind = 'created') as created,
              count(distinct work_item_id) filter (
                where kind = 'updated' and field = 'status' and to_value = 'done') as completed
       from work_item_events
       where tenant_id = $1 and project_id = $2
         and created_at >= date_trunc('week', now()) - make_interval(weeks => $3 - 1)
       group by 1
     )
     select to_char(w.week, 'YYYY-MM-DD') as week,
            coalesce(c.created, 0)::int as created, coalesce(c.completed, 0)::int as completed
     from weeks w left join counted c on c.week = w.week
     order by w.week`,
    [tenantId, projectId, span]
  );
}

export interface BurndownTask {
  status: WorkStatus;
  /** Its story points, or null when not estimated. */
  points?: number | null;
  /** Status changes, oldest first; `day` is the UTC date YYYY-MM-DD. */
  changes: { day: string; from: string | null; to: string | null }[];
}

/**
 * Unfinished work at the end of each day: tasks by default, or story points with
 * `by: 'points'` (an unestimated task counts 0). A task's status on a day is its last change
 * up to that day; before its first change it had that change's starting status.
 * shortcut: counts the sprint's current tasks, at their current points, for every day, so a
 * task added or re-estimated mid-sprint counts from day one; record those changes if that matters.
 */
export function burndownSeries(
  tasks: readonly BurndownTask[],
  days: readonly string[],
  by: 'tasks' | 'points' = 'tasks'
): number[] {
  return days.map((day) =>
    tasks.reduce((sum, task) => {
      let status: string | null = task.changes[0]?.from ?? task.status;
      for (const change of task.changes) {
        if (change.day > day) break;
        status = change.to;
      }
      if (status === 'done') return sum;
      return sum + (by === 'points' ? (task.points ?? 0) : 1);
    }, 0)
  );
}

/** Each UTC date from `start` to `end`, inclusive; at most `max` days. */
export function dayRange(start: string, end: string, max = 90): string[] {
  const days: string[] = [];
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    t <= Date.parse(`${end}T00:00:00Z`) && days.length < max;
    t += 86_400_000
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export interface SprintBurndown {
  days: string[];
  remaining: number[];
  total: number;
  /** The same in story points; all zero when no task in the sprint is estimated. */
  remainingPoints: number[];
  totalPoints: number;
  /** The sprint's last planned day, when it has one, for the ideal line. */
  endsOn: string | null;
}

/** The active or completed sprint's remaining work per day, from its start to today or its end. */
export async function sprintBurndown(
  tenantId: TenantId,
  sprintId: string
): Promise<SprintBurndown | null> {
  if (!UUID.test(sprintId)) return null;
  const [sprint] = await query<{ start: string | null; ends_on: string | null; last: string }>(
    `select coalesce(starts_on, started_at::date)::text as start, ends_on::text as ends_on,
            coalesce(completed_at::date, current_date)::text as last
     from sprints where tenant_id = $1 and id = $2 and status <> 'planned'`,
    [tenantId, sprintId]
  );
  if (!sprint?.start) return null;
  const rows = await query<{
    id: string;
    status: WorkStatus;
    story_points: number | null;
    day: string | null;
    from_value: string | null;
    to_value: string | null;
  }>(
    `select w.id, w.status, w.story_points, (e.created_at at time zone 'UTC')::date::text as day,
            e.from_value, e.to_value
     from work_items w
     left join work_item_events e
       on e.tenant_id = w.tenant_id and e.work_item_id = w.id and e.field = 'status'
     where w.tenant_id = $1 and w.sprint_id = $2
     order by w.id, e.created_at`,
    [tenantId, sprintId]
  );
  const byTask = new Map<string, BurndownTask>();
  for (const r of rows) {
    const task = byTask.get(r.id) ?? {
      status: r.status,
      points: r.story_points,
      changes: [],
    };
    if (r.day) task.changes.push({ day: r.day, from: r.from_value, to: r.to_value });
    byTask.set(r.id, task);
  }
  const days = dayRange(sprint.start, sprint.last);
  const tasks = [...byTask.values()];
  return {
    days,
    remaining: burndownSeries(tasks, days),
    total: tasks.length,
    remainingPoints: burndownSeries(tasks, days, 'points'),
    totalPoints: tasks.reduce((n, t) => n + (t.points ?? 0), 0),
    endsOn: sprint.ends_on,
  };
}

// ---------------------------------------------------------------------------
// Calendar and search
// ---------------------------------------------------------------------------

export type DueTone = 'red' | 'yellow' | 'green';

export const DUE_TONE_LABELS: Record<DueTone, string> = {
  red: 'Overdue or due now',
  yellow: 'Due soon',
  green: 'On track or done',
};

/**
 * How urgent a task's due date is, by time left and priority (null when it has none):
 *   red     overdue, due today, or high/critical and due within 2 days;
 *   yellow  due within 3 days, or high/critical and due within 7;
 *   green   more time than that, or done.
 * `today` is the viewer's day, YYYY-MM-DD.
 */
export function dueTone(
  task: { status: WorkStatus; priority: WorkPriority; due_on: string | null },
  today: string
): DueTone | null {
  if (!task.due_on) return null;
  if (task.status === 'done') return 'green';
  const days = Math.round(
    (Date.parse(`${task.due_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000
  );
  const urgent = task.priority === 'high' || task.priority === 'critical';
  if (days <= (urgent ? 2 : 0)) return 'red';
  if (days <= (urgent ? 7 : 3)) return 'yellow';
  return 'green';
}

/** `?month=2026-11` if it is a real month between 2000 and 2100, else the month of `today`. */
export function parseMonth(raw: string | null | undefined, today: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec((raw ?? '').trim());
  if (
    m &&
    Number(m[1]) >= 2000 &&
    Number(m[1]) <= 2100 &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= 12
  ) {
    return `${m[1]}-${m[2]}`;
  }
  return today.slice(0, 7);
}

/** "2026-11" moved by `delta` months: ("2026-01", -1) → "2025-12". */
export function shiftMonth(month: string, delta: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

/** The weeks (Monday first) that cover a month, as YYYY-MM-DD days; 4 to 6 rows of 7. */
export function monthGrid(month: string): string[][] {
  const first = new Date(`${month}-01T00:00:00Z`);
  const start = new Date(first);
  start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  const weeks: string[][] = [];
  for (const d = new Date(start); weeks.length < 6;) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    weeks.push(week);
    if (d.toISOString().slice(0, 7) !== month) break;
  }
  return weeks;
}

/**
 * Tasks across the workspace whose title contains `q`, or whose id is exactly `q` ("CF-12"),
 * most recently updated first. Like-wildcards in `q` are matched literally.
 */
export async function searchWorkItems(
  tenantId: TenantId,
  q: string,
  limit = 30,
  projectIds: string[] | null = null
): Promise<WorkItemRow[]> {
  const text = q.trim().slice(0, 100);
  if (!text) return [];
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     join projects p on p.id = w.project_id and p.tenant_id = w.tenant_id
     where w.tenant_id = $1
       and (w.title ilike $2 escape '\\'
            or coalesce(p.task_key, 'TASK') || '-' || w.number = upper($3))
       and ($5::uuid[] is null or w.project_id = any($5::uuid[]))
     order by w.updated_at desc
     limit $4`,
    [tenantId, like, text, Math.min(Math.max(limit, 1), 100), projectIds]
  );
}

/**
 * Tasks of the workspace due between two days (inclusive), for the calendar; only one person's
 * with `assigneeId`. Both days are YYYY-MM-DD; anything else returns nothing.
 */
export async function listWorkItemsDue(
  tenantId: TenantId,
  from: string,
  to: string,
  assigneeId?: string,
  projectIds: string[] | null = null
): Promise<WorkItemRow[]> {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to) || (assigneeId && !UUID.test(assigneeId))) return [];
  return query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     where w.tenant_id = $1 and w.due_on between $2::date and $3::date
       and ($4::uuid is null or w.assignee_id = $4::uuid)
       and ($5::uuid[] is null or w.project_id = any($5::uuid[]))
     order by w.due_on, w.number
     limit 1000`,
    [tenantId, from, to, assigneeId ?? null, projectIds]
  );
}

/** Every unfinished task that has an assignee, for the Team page; soonest due first. */
export async function listOpenAssignedWork(tenantId: TenantId): Promise<WorkItemRow[]> {
  return query<WorkItemRow>(
    `${WORK_ITEM_SELECT}
     where w.tenant_id = $1 and w.assignee_id is not null and w.status <> 'done'
     order by w.due_on nulls last, w.number
     limit 2000`,
    [tenantId]
  );
}

/** Task types that can be sent for spec review: requirements, not containers or fragments. */
export const SPEC_REVIEW_TYPES: readonly WorkType[] = ['story', 'task', 'bug'];

export interface SpecReviewResult {
  ticketId: string;
  key: string;
  /** False when the task's text has not changed since it was last sent: nothing new to analyze. */
  isNewVersion: boolean;
}

/**
 * Sends a task to spec review: its title, description and acceptance criteria become a spec
 * ticket (created the first time, a new version when the text changed since), and the task
 * links to it. The ticket's key is the task's key, so a pull request that names the task
 * (`feature/cart-12-…`) links to the ticket too. Any member of the task's project may send;
 * nothing is analyzed until an admin starts a batch.
 */
export async function sendTaskForSpecReview(
  tenantId: TenantId,
  actorId: string,
  itemId: string
): Promise<SpecReviewResult> {
  return tx(async (client) => {
    const item = await lockItem(client, tenantId, itemId);
    await memberRole(client, tenantId, actorId, item.project_id, TASK_MISSING);
    if (!SPEC_REVIEW_TYPES.includes(item.type)) {
      throw new WorkError(
        `${aType(item.type)[0]!.toUpperCase()}${aType(item.type).slice(1)} is not reviewed on its own. Send its stories or tasks instead.`
      );
    }
    const {
      rows: [project],
    } = await client.query<{ task_key: string | null }>(
      `select task_key from projects where tenant_id = $1 and id = $2`,
      [tenantId, item.project_id]
    );
    const key = taskKeyOf(project?.task_key ?? null, item.number);
    const result = await ingestTicketWith(client, tenantId, item.project_id, {
      externalId: `task:${item.id}`,
      externalKey: key,
      title: item.title,
      descriptionText: item.description,
      acceptanceCriteriaText: item.acceptance_criteria,
      raw: { source: 'portal', workItemId: item.id },
      sourceUpdatedAt: new Date(),
    });
    const ticketId = result.ticket.id;
    // The ticket follows the task: its type decides whether it is analyzed, and a finished
    // task's ticket leaves the analysis queue.
    await client.query(
      `update tickets set issue_type = $3,
              status_category = case when $4 = 'done' then 'done' else null end
       where tenant_id = $1 and id = $2`,
      [tenantId, ticketId, item.type, item.status]
    );
    if (item.ticket_id !== ticketId) {
      await client.query(
        `update work_items set ticket_id = $3, updated_at = now() where tenant_id = $1 and id = $2`,
        [tenantId, item.id, ticketId]
      );
    }
    await insertEvent(client, tenantId, {
      projectId: item.project_id,
      workItemId: item.id,
      number: item.number,
      title: item.title,
      actorId,
      kind: 'updated',
      field: 'specReview',
      from: null,
      to: result.isNewVersion ? 'sent for spec review' : 'sent again, unchanged',
    });
    return { ticketId, key, isNewVersion: result.isNewVersion };
  });
}
