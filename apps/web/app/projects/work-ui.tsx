import type { ReactNode } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { projectViews, type ProjectView } from '@/components/app-shell';
import { SubmitButton } from '@/components/submit-button';
import { setProjectStatusAction } from './actions';
import {
  Button,
  EmptyNote,
  Input,
  Label,
  Notice,
  Pill,
  Select,
  Textarea,
  buttonClasses,
  type PillTone,
} from '@/components/ui';
import {
  BOARD_SORT_LABELS,
  DUE_TONE_LABELS,
  WORK_PRIORITIES,
  WORK_PRIORITY_LABELS,
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  dueTone,
  monthGrid,
  linkLabel,
  parentTypesFor,
  taskKeyOf,
  type BoardQuery,
  type BoardSort,
  type DueTone,
  type LinkKind,
  type LinkableScenarioRow,
  type LinkableTicketRow,
  type MemberRow,
  type ProjectStatus,
  type WorkEventRow,
  type WorkItemRow,
  type WorkPriority,
  type WorkStatus,
} from '@/lib/repos';

// Shared pieces of the project and task pages. All server components: forms post to server
// actions, so they work without JavaScript.

/**
 * The top of every project view, as in Jira: the project's name with a Create button, then one
 * tab per view. The same views are listed under the project in the sidebar.
 */
export function ProjectHeader({
  projectId,
  name,
  active,
  canManage,
  aside,
}: {
  projectId: string;
  name: string;
  active: ProjectView;
  canManage: boolean;
  /** Extra details beside the name, such as the project's status. */
  aside?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-[-0.012em]">{name}</h1>
          {aside}
        </div>
        {/* On a desktop the top bar's "Create task" does this; a phone has no top bar button. */}
        <Link
          href={`/projects/${projectId}/tasks/new`}
          className={cn(buttonClasses('default'), 'lg:hidden')}
        >
          <Plus aria-hidden size={16} strokeWidth={2} />
          Create task
        </Link>
      </div>
      <nav
        aria-label="Project views"
        className="-mx-1 flex gap-1 overflow-x-auto overflow-y-hidden px-1 shadow-[inset_0_-1px_0_rgb(var(--border))]"
      >
        {projectViews(projectId, canManage).map((view) => (
          <Link
            key={view.key}
            href={view.href}
            aria-current={active === view.key ? 'page' : undefined}
            className={cn(
              'tab-link inline-flex h-10 flex-none items-center border-b-2 px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
              active === view.key
                ? 'border-text font-medium text-text'
                : 'border-transparent text-muted-foreground hover:text-text'
            )}
          >
            {view.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

const STATUS_TONES: Record<WorkStatus, PillTone> = {
  todo: 'neutral',
  in_progress: 'accent',
  in_review: 'warning',
  done: 'positive',
};
const PRIORITY_TONES: Record<WorkPriority, PillTone> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'warning',
  critical: 'negative',
};
// Running is yellow, completed is green; the word is always written next to the dot.
const PROJECT_TONES: Record<ProjectStatus, PillTone> = {
  active: 'warning',
  on_hold: 'negative',
  completed: 'positive',
  archived: 'neutral',
};

export function StatusPill({ status }: { status: WorkStatus }) {
  return <Pill tone={STATUS_TONES[status]}>{WORK_STATUS_LABELS[status]}</Pill>;
}

export function PriorityPill({ priority }: { priority: WorkPriority }) {
  return <Pill tone={PRIORITY_TONES[priority]}>{WORK_PRIORITY_LABELS[priority]}</Pill>;
}

export function ProjectStatusPill({ status }: { status: ProjectStatus }) {
  return (
    <Pill tone={PROJECT_TONES[status]} className="gap-1.5">
      <span aria-hidden className="size-2 flex-none rounded-full bg-current" />
      {PROJECT_STATUS_LABELS[status]}
    </Pill>
  );
}

/**
 * The owner's control to mark a project running, on hold, completed or archived. It can be
 * changed back any time. `from` is the page to return to.
 */
export function ProjectStatusForm({
  projectId,
  status,
  from,
}: {
  projectId: string;
  status: ProjectStatus;
  from: 'summary' | 'settings';
}) {
  return (
    <form action={setProjectStatusAction} className="flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="from" value={from} />
      <ProjectStatusPill status={status} />
      <Select
        name="status"
        aria-label="Project status"
        defaultValue={status}
        className="h-8 w-auto text-xs"
      >
        {PROJECT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {PROJECT_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">
        Set
      </SubmitButton>
    </form>
  );
}

/** A done-of-total bar with its numbers written out; the text carries the meaning. */
export function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {done} of {total} done · {percent}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-2 h-2 overflow-hidden rounded-full bg-raised"
      >
        <div
          className="bar-fill h-full rounded-full bg-positive"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Every editable field of a task. With `task` it is the edit form, prefilled; without, the
 * create form (`defaultTicketId` preselects a spec ticket, `defaultParent` a parent task and
 * the type that fits under it). `idPrefix` keeps element ids unique when two forms share a page.
 */
export function TaskFormFields({
  task,
  members,
  tickets,
  scenarios,
  tasks,
  taskKey,
  defaultTicketId,
  defaultParent,
  defaultDueOn,
  idPrefix,
  part = 'all',
  formId,
}: {
  task?: WorkItemRow;
  members: MemberRow[];
  tickets: LinkableTicketRow[];
  scenarios: LinkableScenarioRow[];
  /** The project's tasks, the candidates for a parent. */
  tasks: WorkItemRow[];
  taskKey: string | null;
  defaultTicketId?: string;
  defaultParent?: WorkItemRow;
  /** YYYY-MM-DD, from a calendar day's "+". */
  defaultDueOn?: string;
  idPrefix: string;
  /** 'main' is the title and description, 'details' the rest; 'all' both, in a two-column grid. */
  part?: 'all' | 'main' | 'details';
  /** The id of the form the controls belong to, when they sit outside it. */
  formId?: string;
}) {
  const inForm = formId ? { form: formId } : {};
  const id = (name: string) => `${idPrefix}-${name}`;
  const candidates = tasks.filter((t) => t.id !== task?.id);
  const parentOption = (t: WorkItemRow) => (
    <option key={t.id} value={t.id}>
      {taskKeyOf(taskKey, t.number)} — {t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title}
    </option>
  );
  const epics = candidates.filter((t) => t.type === 'epic');
  const middles = candidates.filter((t) => parentTypesFor('subtask').includes(t.type));
  const defaultType = defaultParent
    ? defaultParent.type === 'epic'
      ? 'story'
      : 'subtask'
    : 'task';
  const main = (
    <>
      <div className="sm:col-span-2">
        <Field label="Title" htmlFor={id('title')}>
          <Input
            {...inForm}
            id={id('title')}
            name="title"
            required
            maxLength={200}
            defaultValue={task?.title}
            autoComplete="off"
          />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Description" htmlFor={id('description')}>
          <Textarea
            {...inForm}
            id={id('description')}
            name="description"
            rows={5}
            maxLength={20000}
            defaultValue={task?.description}
          />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Acceptance criteria" htmlFor={id('acceptanceCriteria')}>
          <Textarea
            {...inForm}
            id={id('acceptanceCriteria')}
            name="acceptanceCriteria"
            rows={4}
            maxLength={20000}
            placeholder={
              'One condition per line, e.g.\nGiven a cart over ₹500, when the coupon is applied, then the total drops by 10%.'
            }
            defaultValue={task?.acceptance_criteria}
          />
        </Field>
      </div>
    </>
  );
  const details = (
    <>
      <Field label="Type" htmlFor={id('type')}>
        <Select {...inForm} id={id('type')} name="type" defaultValue={task?.type ?? defaultType}>
          {WORK_TYPES.map((t) => (
            <option key={t} value={t}>
              {WORK_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Priority" htmlFor={id('priority')}>
        <Select
          {...inForm}
          id={id('priority')}
          name="priority"
          defaultValue={task?.priority ?? 'medium'}
        >
          {WORK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {WORK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status" htmlFor={id('status')}>
        <Select {...inForm} id={id('status')} name="status" defaultValue={task?.status ?? 'todo'}>
          {WORK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {WORK_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Assignee" htmlFor={id('assignee')}>
        <Select
          {...inForm}
          id={id('assignee')}
          name="assigneeId"
          defaultValue={task?.assignee_id ?? ''}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.email ?? 'Member'}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Due date" htmlFor={id('due')}>
        <Input
          {...inForm}
          id={id('due')}
          name="dueOn"
          type="date"
          defaultValue={task?.due_on ?? defaultDueOn ?? ''}
        />
      </Field>
      <Field
        label="Parent"
        htmlFor={id('parent')}
        hint="Stories, tasks and bugs go under an epic; a sub-task under a story, task or bug."
      >
        <Select
          {...inForm}
          id={id('parent')}
          name="parentId"
          defaultValue={task?.parent_id ?? defaultParent?.id ?? ''}
        >
          <option value="">None</option>
          {epics.length ? <optgroup label="Epics">{epics.map(parentOption)}</optgroup> : null}
          {middles.length ? (
            <optgroup label="Stories, tasks and bugs">{middles.map(parentOption)}</optgroup>
          ) : null}
        </Select>
      </Field>
      <Field label="Story points" htmlFor={id('points')} hint="A whole number, 0–100.">
        <Input
          {...inForm}
          id={id('points')}
          name="storyPoints"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          defaultValue={task?.story_points ?? ''}
        />
      </Field>
      <Field label="Linked spec ticket" htmlFor={id('ticket')}>
        <Select
          {...inForm}
          id={id('ticket')}
          name="ticketId"
          defaultValue={task?.ticket_id ?? defaultTicketId ?? ''}
        >
          <option value="">None</option>
          {tickets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.external_key} — {t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Linked scenario"
        htmlFor={id('scenario')}
        hint="Its ticket is linked too. Must match the ticket above, if one is chosen."
      >
        <Select
          {...inForm}
          id={id('scenario')}
          name="scenarioId"
          defaultValue={task?.scenario_id ?? ''}
        >
          <option value="">None</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.ticket_key} — {s.title.length > 60 ? `${s.title.slice(0, 60)}…` : s.title}
              {s.status === 'approved' || s.status === 'edited' ? '' : ` (${s.status})`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Labels" htmlFor={id('labels')} hint="Separate with commas.">
        <Input
          {...inForm}
          id={id('labels')}
          name="labels"
          defaultValue={task?.labels.join(', ')}
          autoComplete="off"
          placeholder="frontend, checkout"
        />
      </Field>
      <Field label="Components" htmlFor={id('components')} hint="Separate with commas.">
        <Input
          {...inForm}
          id={id('components')}
          name="components"
          defaultValue={task?.components.join(', ')}
          autoComplete="off"
          placeholder="payments-api"
        />
      </Field>
    </>
  );
  if (part === 'main') return <div className="space-y-4">{main}</div>;
  if (part === 'details') return <div className="space-y-4">{details}</div>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {main}
      {details}
    </div>
  );
}

const FIELD_NAMES: Record<string, string> = {
  title: 'title',
  description: 'description',
  acceptanceCriteria: 'acceptance criteria',
  type: 'type',
  priority: 'priority',
  status: 'status',
  assigneeId: 'assignee',
  dueOn: 'due date',
  labels: 'labels',
  components: 'components',
  ticketId: 'linked ticket',
  scenarioId: 'linked scenario',
  parentId: 'parent',
  storyPoints: 'story points',
  sprint: 'sprint',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  status: WORK_STATUS_LABELS,
  type: WORK_TYPE_LABELS,
  priority: WORK_PRIORITY_LABELS,
};

/** One activity row as a sentence, e.g. "changed status from To Do to In Progress". */
export function describeEvent(e: WorkEventRow): string {
  switch (e.kind) {
    case 'created':
      return 'created the task';
    case 'deleted':
      return 'deleted the task';
    case 'commented':
      return 'commented';
    case 'sprint_created':
      return `created sprint ${e.item_title ?? ''}`;
    case 'sprint_updated':
      return `edited sprint ${e.item_title ?? ''}`;
    case 'sprint_started':
      return `started sprint ${e.item_title ?? ''}`;
    case 'sprint_completed':
      return `completed sprint ${e.item_title ?? ''}${e.to_value ? ` (${e.to_value})` : ''}`;
    case 'linked':
    case 'unlinked': {
      const kind = (e.field ?? 'relates') as LinkKind;
      const verb = e.kind === 'linked' ? 'linked' : 'removed the link';
      return `${verb}: ${linkLabel(kind, 'out')} ${e.to_value ?? 'a task'}`;
    }
    case 'updated': {
      const field = e.field ?? '';
      const name = FIELD_NAMES[field] ?? field;
      if (field === 'description') return 'edited the description';
      if (field === 'acceptanceCriteria') return 'edited the acceptance criteria';
      if (field === 'specReview') return e.to_value ?? 'sent the task for spec review';
      const show = (v: string | null) => (v === null ? 'none' : (VALUE_LABELS[field]?.[v] ?? v));
      return `changed ${name} from ${show(e.from_value)} to ${show(e.to_value)}`;
    }
    default:
      return e.kind.replace(/_/g, ' ');
  }
}

const when = (d: Date) =>
  new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Activity, newest first. With `projectKey` (the project page) each row names its task and
 * links to it while it still exists; without (the task page) the task is implied.
 */
export function ActivityList({
  events,
  projectId,
  projectKey,
  empty,
}: {
  events: WorkEventRow[];
  projectId: string;
  projectKey?: string | null;
  empty: string;
}) {
  if (events.length === 0) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <ol className="space-y-3">
      {events.map((e) => {
        const key =
          projectKey === undefined || e.item_number === null
            ? null
            : taskKeyOf(projectKey, e.item_number);
        return (
          <li key={e.id} className="text-sm leading-5">
            <p>
              <span className="font-medium">{e.actor_email ?? 'Someone'}</span> {describeEvent(e)}
              {key ? (
                <>
                  {' '}
                  on{' '}
                  {e.work_item_id ? (
                    <Link
                      href={`/projects/${projectId}/tasks/${e.item_number}`}
                      className="font-mono text-[13px] underline-offset-[3px] hover:underline"
                    >
                      {key}
                    </Link>
                  ) : (
                    <span className="font-mono text-[13px]">{key}</span>
                  )}
                  {e.item_title ? (
                    <span className="text-muted-foreground"> {e.item_title}</span>
                  ) : null}
                </>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={new Date(e.created_at).toISOString()}>{when(e.created_at)}</time>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** Shown until migration 0019 is applied; the rest of SpecFix is unaffected. */
export function NotMigrated() {
  return (
    <Notice tone="warning" title="Task tracking is not set up on this database yet">
      An admin needs to apply the latest database migration (<code>npm run db:migrate</code>). Spec
      review, scenarios and integrations keep working meanwhile.
    </Notice>
  );
}

/** "2026-11-02" → "2 Nov". */
export function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** The epics of a project, as the filter and the task form list them. */
export const epicsOf = (tasks: readonly WorkItemRow[]) => tasks.filter((t) => t.type === 'epic');

/**
 * Search and filters for the board and backlog. A plain GET form: the filters live in the
 * URL, so a filtered view can be shared or bookmarked, and the page reads them back with
 * parseBoardQuery.
 */
export function TaskFilters({
  action,
  query,
  members,
  labels,
  epics,
  taskKey,
  sorts,
  filtered,
}: {
  /** The page the form submits to and Clear returns to. */
  action: string;
  query: BoardQuery;
  members: MemberRow[];
  labels: string[];
  epics: WorkItemRow[];
  taskKey: string | null;
  sorts: readonly BoardSort[];
  filtered: boolean;
}) {
  return (
    <form
      method="get"
      action={action}
      role="search"
      aria-label="Filter tasks"
      className="mb-4 grid gap-3 rounded-lg border border-border bg-sheet p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[minmax(12rem,1.5fr)_repeat(6,minmax(0,1fr))_auto]"
    >
      <FilterField label="Search" htmlFor="filter-q">
        <Input
          id="filter-q"
          name="q"
          type="search"
          defaultValue={query.q}
          maxLength={100}
          placeholder="Title, label or id"
          autoComplete="off"
        />
      </FilterField>
      <FilterField label="Epic" htmlFor="filter-epic">
        <Select id="filter-epic" name="epic" defaultValue={query.epic ?? ''}>
          <option value="">Any epic</option>
          <option value="none">No epic</option>
          {epics.map((e) => (
            <option key={e.id} value={e.id}>
              {taskKeyOf(taskKey, e.number)} —{' '}
              {e.title.length > 40 ? `${e.title.slice(0, 40)}…` : e.title}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Type" htmlFor="filter-type">
        <Select id="filter-type" name="type" defaultValue={query.type ?? ''}>
          <option value="">All types</option>
          {WORK_TYPES.map((v) => (
            <option key={v} value={v}>
              {WORK_TYPE_LABELS[v]}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Priority" htmlFor="filter-priority">
        <Select id="filter-priority" name="priority" defaultValue={query.priority ?? ''}>
          <option value="">All priorities</option>
          {WORK_PRIORITIES.map((v) => (
            <option key={v} value={v}>
              {WORK_PRIORITY_LABELS[v]}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Assignee" htmlFor="filter-assignee">
        <Select id="filter-assignee" name="assignee" defaultValue={query.assignee ?? ''}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.email ?? 'Member'}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Label" htmlFor="filter-label">
        <Select id="filter-label" name="label" defaultValue={query.label ?? ''}>
          <option value="">Any label</option>
          {labels.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label="Sort" htmlFor="filter-sort">
        <Select id="filter-sort" name="sort" defaultValue={query.sort}>
          {sorts.map((v) => (
            <option key={v} value={v}>
              {BOARD_SORT_LABELS[v]}
            </option>
          ))}
        </Select>
      </FilterField>
      <div className="flex items-end gap-2">
        <Button type="submit" variant="outline">
          Apply
        </Button>
        {filtered ? (
          <Link href={action} className={buttonClasses('ghost')}>
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Whether any filter differs from the page's default view. */
export const isFiltered = (query: BoardQuery, defaultSort: BoardSort) =>
  Boolean(query.q || query.type || query.priority || query.assignee || query.label || query.epic) ||
  query.sort !== defaultSort;

const TONE_CLASSES: Record<DueTone, string> = {
  red: 'border-l-negative bg-negative-bg text-negative-ink',
  yellow: 'border-l-warning bg-warning-bg text-warning-ink',
  green: 'border-l-positive bg-positive-bg text-positive-ink',
};
const TONE_DOT: Record<DueTone, string> = {
  red: 'bg-negative',
  yellow: 'bg-warning',
  green: 'bg-positive',
};

/** The red / yellow / green key under a calendar. */
export function DueToneLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {(Object.keys(DUE_TONE_LABELS) as DueTone[]).map((tone) => (
        <li key={tone} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('h-2.5 w-2.5 rounded-full', TONE_DOT[tone])} />
          {DUE_TONE_LABELS[tone]}
        </li>
      ))}
      <li>Red: overdue, due today, or high priority due within 2 days.</li>
    </ul>
  );
}

/**
 * A month of tasks by due date, as Jira's calendar: each task sits on its due day, coloured
 * red, yellow or green by how urgent it is (see dueTone). With `addHref`, every day has a "+"
 * that opens Create with that due date. Plain links, so it works without JavaScript.
 */
export function CalendarGrid({
  month,
  today,
  tasks,
  keyOf,
  prevHref,
  nextHref,
  todayHref,
  addHref,
  label,
}: {
  month: string;
  today: string;
  tasks: Pick<
    WorkItemRow,
    'id' | 'project_id' | 'number' | 'title' | 'status' | 'priority' | 'due_on'
  >[];
  keyOf: (projectId: string, number: number) => string;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  addHref?: (day: string) => string;
  label: string;
}) {
  const weeks = monthGrid(month);
  const byDay = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (!task.due_on) continue;
    byDay.set(task.due_on, [...(byDay.get(task.due_on) ?? []), task]);
  }
  const title = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const navLink =
    'inline-flex h-9 items-center rounded-md border border-border px-3 text-sm hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal';
  return (
    <section aria-label={label} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="flex gap-2">
          <Link href={prevHref} className={navLink} aria-label="Previous month">
            ‹ Prev
          </Link>
          <Link href={todayHref} className={navLink}>
            Today
          </Link>
          <Link href={nextHref} className={navLink} aria-label="Next month">
            Next ›
          </Link>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-sheet">
        <table className="w-full min-w-[48rem] table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <th key={d} scope="col" className="px-2 py-2 text-left font-medium">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]} className="border-b border-border last:border-b-0">
                {week.map((day) => {
                  const inMonth = day.slice(0, 7) === month;
                  const list = byDay.get(day) ?? [];
                  return (
                    <td
                      key={day}
                      className={cn(
                        'h-28 border-r border-border p-1.5 align-top last:border-r-0',
                        !inMonth && 'bg-raised/40'
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={cn(
                            'inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums',
                            day === today
                              ? 'bg-text font-semibold text-sheet'
                              : inMonth
                                ? 'text-text'
                                : 'text-muted-foreground'
                          )}
                          {...(day === today ? { 'aria-current': 'date' as const } : {})}
                        >
                          {Number(day.slice(8))}
                        </span>
                        {addHref ? (
                          <Link
                            href={addHref(day)}
                            className="rounded px-1.5 text-xs text-muted-foreground hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                            aria-label={`Create a task due ${day}`}
                          >
                            +
                          </Link>
                        ) : null}
                      </div>
                      <ul className="space-y-1">
                        {list.slice(0, 3).map((task) => {
                          const tone = dueTone(task, today) ?? 'green';
                          return (
                            <li key={task.id}>
                              <Link
                                href={`/projects/${task.project_id}/tasks/${task.number}`}
                                title={`${keyOf(task.project_id, task.number)} ${task.title} — ${DUE_TONE_LABELS[tone]}`}
                                className={cn(
                                  'block truncate rounded-sm border-l-[3px] px-1.5 py-0.5 text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
                                  TONE_CLASSES[tone],
                                  task.status === 'done' && 'line-through opacity-70'
                                )}
                              >
                                <span className="font-mono">
                                  {keyOf(task.project_id, task.number)}
                                </span>{' '}
                                {task.title}
                              </Link>
                            </li>
                          );
                        })}
                        {list.length > 3 ? (
                          <li className="px-1.5 text-xs text-muted-foreground">
                            +{list.length - 3} more
                          </li>
                        ) : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DueToneLegend />
    </section>
  );
}
