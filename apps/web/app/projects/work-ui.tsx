import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import {
  EmptyNote,
  Input,
  Label,
  Notice,
  Pill,
  Select,
  Textarea,
  type PillTone,
} from '@/components/ui';
import {
  WORK_PRIORITIES,
  WORK_PRIORITY_LABELS,
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
  linkLabel,
  taskKeyOf,
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

type ProjectTab = 'overview' | 'board' | 'backlog' | 'queue';

/** Overview / Spec queue switcher, styled like the ticket tabs. */
export function ProjectTabs({ projectId, active }: { projectId: string; active: ProjectTab }) {
  const tab = (href: string, key: ProjectTab, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={cn(
        '-mb-px inline-flex h-10 items-center border-b-2 px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
        active === key
          ? 'border-text font-medium text-text'
          : 'border-transparent text-muted-foreground hover:text-text'
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Project views" className="mb-6 flex gap-2 border-b border-border">
      {tab(`/projects/${projectId}`, 'overview', 'Overview')}
      {tab(`/projects/${projectId}/board`, 'board', 'Board')}
      {tab(`/projects/${projectId}/backlog`, 'backlog', 'Backlog')}
      {tab(`/?project=${projectId}`, 'queue', 'Spec queue')}
    </nav>
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
const PROJECT_TONES: Record<ProjectStatus, PillTone> = {
  active: 'positive',
  on_hold: 'warning',
  completed: 'accent',
  archived: 'neutral',
};

export function StatusPill({ status }: { status: WorkStatus }) {
  return <Pill tone={STATUS_TONES[status]}>{WORK_STATUS_LABELS[status]}</Pill>;
}

export function PriorityPill({ priority }: { priority: WorkPriority }) {
  return <Pill tone={PRIORITY_TONES[priority]}>{WORK_PRIORITY_LABELS[priority]}</Pill>;
}

export function ProjectStatusPill({ status }: { status: ProjectStatus }) {
  return <Pill tone={PROJECT_TONES[status]}>{PROJECT_STATUS_LABELS[status]}</Pill>;
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
        <div className="h-full rounded-full bg-positive" style={{ width: `${percent}%` }} />
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
 * create form (`defaultTicketId` preselects a spec ticket). `idPrefix` keeps element ids
 * unique when two forms share a page.
 */
export function TaskFormFields({
  task,
  members,
  tickets,
  scenarios,
  defaultTicketId,
  idPrefix,
}: {
  task?: WorkItemRow;
  members: MemberRow[];
  tickets: LinkableTicketRow[];
  scenarios: LinkableScenarioRow[];
  defaultTicketId?: string;
  idPrefix: string;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Title" htmlFor={id('title')}>
          <Input
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
            id={id('description')}
            name="description"
            rows={5}
            maxLength={20000}
            defaultValue={task?.description}
          />
        </Field>
      </div>
      <Field label="Type" htmlFor={id('type')}>
        <Select id={id('type')} name="type" defaultValue={task?.type ?? 'task'}>
          {WORK_TYPES.map((t) => (
            <option key={t} value={t}>
              {WORK_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Priority" htmlFor={id('priority')}>
        <Select id={id('priority')} name="priority" defaultValue={task?.priority ?? 'medium'}>
          {WORK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {WORK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status" htmlFor={id('status')}>
        <Select id={id('status')} name="status" defaultValue={task?.status ?? 'todo'}>
          {WORK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {WORK_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Assignee" htmlFor={id('assignee')}>
        <Select id={id('assignee')} name="assigneeId" defaultValue={task?.assignee_id ?? ''}>
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.email ?? 'Member'}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Due date" htmlFor={id('due')}>
        <Input id={id('due')} name="dueOn" type="date" defaultValue={task?.due_on ?? ''} />
      </Field>
      <Field label="Linked spec ticket" htmlFor={id('ticket')}>
        <Select
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
        <Select id={id('scenario')} name="scenarioId" defaultValue={task?.scenario_id ?? ''}>
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
          id={id('labels')}
          name="labels"
          defaultValue={task?.labels.join(', ')}
          autoComplete="off"
          placeholder="frontend, checkout"
        />
      </Field>
      <Field label="Components" htmlFor={id('components')} hint="Separate with commas.">
        <Input
          id={id('components')}
          name="components"
          defaultValue={task?.components.join(', ')}
          autoComplete="off"
          placeholder="payments-api"
        />
      </Field>
    </div>
  );
}

const FIELD_NAMES: Record<string, string> = {
  title: 'title',
  description: 'description',
  type: 'type',
  priority: 'priority',
  status: 'status',
  assigneeId: 'assignee',
  dueOn: 'due date',
  labels: 'labels',
  components: 'components',
  ticketId: 'linked ticket',
  scenarioId: 'linked scenario',
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
