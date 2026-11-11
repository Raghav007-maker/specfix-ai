/**
 * Project work tracking: tasks (work items), their activity, and project details.
 *
 * Tasks are SpecFix's own and sit beside the spec tickets: a task may point at a ticket
 * or a scenario, but nothing here writes to tickets, scenarios or Jira.
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

export const WORK_TYPES = ['task', 'bug', 'story', 'epic'] as const;
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
};
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
  active: 'Active',
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
    | 'type'
    | 'priority'
    | 'status'
    | 'assigneeId'
    | 'dueOn'
    | 'labels'
    | 'components'
    | 'ticketId'
    | 'scenarioId',
    string | null
  >
>;

export interface TaskFields {
  title: string;
  description: string;
  type: WorkType;
  priority: WorkPriority;
  status: WorkStatus;
  assigneeId: string | null;
  dueOn: string | null;
  labels: string[];
  components: string[];
  ticketId: string | null;
  scenarioId: string | null;
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
  const pick = <T extends string>(list: readonly T[], value: string | null | undefined, d: T) => {
    if (!value) return d;
    if (!oneOf(list, value)) throw new WorkError('Choose one of the listed options.');
    return value;
  };
  return {
    title,
    description,
    type: pick(WORK_TYPES, raw.type, 'task'),
    priority: pick(WORK_PRIORITIES, raw.priority, 'medium'),
    status: pick(WORK_STATUSES, raw.status, 'todo'),
    assigneeId: optionalId(raw.assigneeId, 'assignee'),
    dueOn: parseDueDate(raw.dueOn),
    labels: parseTagList(raw.labels, 'labels'),
    components: parseTagList(raw.components, 'components'),
    ticketId: optionalId(raw.ticketId, 'ticket'),
    scenarioId: optionalId(raw.scenarioId, 'scenario'),
  };
}

export type TaskField = keyof TaskFields;
export interface TaskChange {
  field: TaskField;
  from: string | null;
  to: string | null;
}

const asText = (v: TaskFields[TaskField]): string | null =>
  Array.isArray(v) ? (v.length ? v.join(', ') : null) : v === '' ? null : v;

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
  return {
    q: one('q').slice(0, 100),
    type: oneOf(WORK_TYPES, type) ? type : null,
    priority: oneOf(WORK_PRIORITIES, priority) ? priority : null,
    assignee:
      assignee === 'me' || assignee === 'none' || UUID.test(assignee)
        ? assignee.toLowerCase()
        : null,
    label: one('label').slice(0, MAX_TAG_LENGTH) || null,
    sort: oneOf(BOARD_SORTS, sort) ? sort : 'rank',
  };
}

const PRIORITY_ORDER: Record<WorkPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type BoardRow = Pick<
  WorkItemRow,
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
  const filtered = rows.filter(
    (r) =>
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

/** Whether migration 0019 has been applied, so pages can say so instead of failing. */
export async function workTablesAvailable(): Promise<boolean> {
  if (workTablesSeen) return true;
  const [row] = await query<{ available: boolean }>(
    `select to_regclass('public.work_items') is not null as available`,
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
  created_at: Date;
  updated_at: Date;
}

// The joins resolve display names for ids already scoped to this tenant's task row.
const WORK_ITEM_SELECT = `
  select w.id, w.project_id, w.number, w.type, w.priority, w.status, w.title, w.description,
         w.assignee_id, au.email as assignee_email, w.reporter_id, ru.email as reporter_email,
         w.due_on::text as due_on,
         (w.due_on is not null and w.due_on < current_date and w.status <> 'done') as overdue,
         w.labels, w.components, w.sprint_id, sp.name as sprint_name, w.rank,
         w.ticket_id, t.external_key as ticket_key, t.title as ticket_title,
         w.scenario_id, s.title as scenario_title, w.created_at, w.updated_at
  from work_items w
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

/** Recent activity of a project, of one task, or of the whole workspace, newest first. */
export async function listWorkEvents(
  tenantId: TenantId,
  scope: { projectId?: string; workItemId?: string },
  limit = 30
): Promise<WorkEventRow[]> {
  if (
    (scope.projectId && !UUID.test(scope.projectId)) ||
    (scope.workItemId && !UUID.test(scope.workItemId))
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
     order by e.created_at desc, e.id
     limit $4`,
    [tenantId, scope.projectId ?? null, scope.workItemId ?? null, Math.min(Math.max(limit, 1), 200)]
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

async function memberRole(client: PoolClient, tenantId: TenantId, userId: string): Promise<Role> {
  const {
    rows: [row],
  } = await client.query<{ role: Role }>(
    `select role from memberships where tenant_id = $1 and user_id = $2`,
    [tenantId, userId]
  );
  if (!row) throw new WorkError('You are not a member of this workspace.');
  return row.role;
}

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
    const { rowCount } = await client.query(
      `select 1 from memberships where tenant_id = $1 and user_id = $2`,
      [tenantId, fields.assigneeId]
    );
    if (!rowCount) throw new WorkError('The assignee must be a member of this workspace.');
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
  const names = new Map<string, string>();
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
    c.field === 'assigneeId' || c.field === 'ticketId' || c.field === 'scenarioId'
      ? { ...c, from: show(c.from), to: show(c.to) }
      : c
  );
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
    await memberRole(client, tenantId, actorId);
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
          assignee_id, reporter_id, due_on, labels, components, ticket_id, scenario_id, rank)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
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
  type: WorkType;
  priority: WorkPriority;
  status: WorkStatus;
  assignee_id: string | null;
  due_on: string | null;
  labels: string[];
  components: string[];
  ticket_id: string | null;
  scenario_id: string | null;
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
            due_on::text as due_on, labels, components, ticket_id, scenario_id
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
  type: item.type,
  priority: item.priority,
  status: item.status,
  assigneeId: item.assignee_id,
  dueOn: item.due_on,
  labels: item.labels,
  components: item.components,
  ticketId: item.ticket_id,
  scenarioId: item.scenario_id,
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
    await memberRole(client, tenantId, actorId);
    const item = await lockItem(client, tenantId, itemId);
    const fields = await resolveReferences(client, tenantId, item.project_id, input);
    const changes = diffTask(fieldsOf(item), fields);
    if (changes.length === 0) return [];

    const moved = fields.status !== item.status;
    await client.query(
      `update work_items
         set title = $3, description = $4, type = $5, priority = $6, status = $7,
             assignee_id = $8, due_on = $9, labels = $10, components = $11, ticket_id = $12,
             scenario_id = $15,
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
    await memberRole(client, tenantId, actorId);
    const item = await lockItem(client, tenantId, itemId);
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
): Promise<{ projectId: string; number: number }> {
  return tx(async (client) => {
    if (!canManage(await memberRole(client, tenantId, actorId))) {
      throw new WorkError('Only owners and admins can delete tasks.');
    }
    const item = await lockItem(client, tenantId, itemId);
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
    return { projectId: item.project_id, number: item.number };
  });
}

/** Changes a project's description, status and task key (owners and admins only). */
export async function updateProjectDetails(
  tenantId: TenantId,
  actorId: string,
  projectId: string,
  input: { description: string; status: string; taskKey: string }
): Promise<void> {
  const description = input.description.replace(/\r\n/g, '\n').trim();
  if (description.length > 5000) {
    throw new WorkError('A project description can be at most 5,000 characters.');
  }
  if (!oneOf(PROJECT_STATUSES, input.status)) throw new WorkError('Choose a project status.');
  const taskKey = input.taskKey.trim() ? normalizeTaskKey(input.taskKey) : null;
  if (!UUID.test(projectId)) throw new WorkError('That project is not in this workspace.');

  await tx(async (client) => {
    if (!canManage(await memberRole(client, tenantId, actorId))) {
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
         set description = $3, status = $4, task_key = coalesce($5, task_key)
       where tenant_id = $1 and id = $2`,
      [tenantId, projectId, description, input.status, taskKey]
    );
    if (!rowCount) throw new WorkError('That project is not in this workspace.');
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
    await memberRole(client, tenantId, actorId);
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
    await memberRole(client, tenantId, actorId);
    const item = await lockItem(client, tenantId, itemId);
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
    const role = await memberRole(client, tenantId, actorId);
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
    await memberRole(client, tenantId, actorId);
    const from = await lockItem(client, tenantId, input.fromId);
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
    await memberRole(client, tenantId, actorId);
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

async function requireManager(client: PoolClient, tenantId: TenantId, actorId: string) {
  if (!canManage(await memberRole(client, tenantId, actorId))) {
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
    await requireManager(client, tenantId, actorId);
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
    await requireManager(client, tenantId, actorId);
    const sprint = await lockSprint(client, tenantId, sprintId);
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
      await requireManager(client, tenantId, actorId);
      const sprint = await lockSprint(client, tenantId, sprintId);
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
    await requireManager(client, tenantId, actorId);
    const sprint = await lockSprint(client, tenantId, sprintId);
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
    await memberRole(client, tenantId, actorId);
    const item = await lockItem(client, tenantId, itemId);
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
