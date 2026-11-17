import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  listProjectDetails,
  listProjects,
  listWorkItemsDue,
  monthGrid,
  parseMonth,
  shiftMonth,
  taskKeyOf,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import { cn } from '@/lib/cn';
import { CalendarGrid, NotMigrated } from '../projects/work-ui';

/**
 * Every project's tasks on one month calendar by due date, coloured red / yellow / green by
 * urgency; `?mine=1` keeps only tasks assigned to you. A project's own calendar is on its
 * Calendar tab, where "+" on a day creates a task.
 */
export default async function WorkspaceCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; mine?: string }>;
}) {
  const [user, { month: monthParam, mine }] = await Promise.all([requireUser(), searchParams]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t), workTablesAvailable()]);

  const today = new Date().toISOString().slice(0, 10);
  const month = parseMonth(monthParam, today);
  const onlyMine = mine === '1';
  const grid = monthGrid(month);
  const [details, tasks] = migrated
    ? await Promise.all([
        listProjectDetails(t),
        listWorkItemsDue(t, grid[0]![0]!, grid.at(-1)!.at(-1)!, onlyMine ? user.id : undefined),
      ])
    : [[], []];
  const byId = new Map(details.map((p) => [p.id, p]));
  const href = (m: string, mineFlag = onlyMine) =>
    `/calendar?month=${m}${mineFlag ? '&mine=1' : ''}`;
  const toggle = (label: string, value: boolean) => (
    <Link
      href={href(month, value)}
      aria-current={onlyMine === value ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 items-center rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal',
        onlyMine === value
          ? 'bg-text font-medium text-sheet'
          : 'text-muted-foreground hover:bg-raised hover:text-text'
      )}
    >
      {label}
    </Link>
  );

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="calendar"
      breadcrumb={<p className="text-sm text-muted-foreground">Calendar</p>}
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.012em]">Calendar</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tasks from every project by due date. To add one on a day, open a project&apos;s
            Calendar tab.
          </p>
        </div>
        <div
          role="group"
          aria-label="Whose tasks"
          className="flex gap-1 rounded-lg border border-border bg-sheet p-1"
        >
          {toggle('Everyone', false)}
          {toggle('Assigned to me', true)}
        </div>
      </div>
      {!migrated ? (
        <NotMigrated />
      ) : (
        <CalendarGrid
          label="Workspace calendar"
          month={month}
          today={today}
          tasks={tasks}
          keyOf={(projectId, n) => taskKeyOf(byId.get(projectId)?.task_key ?? null, n)}
          prevHref={href(shiftMonth(month, -1))}
          nextHref={href(shiftMonth(month, 1))}
          todayHref={onlyMine ? '/calendar?mine=1' : '/calendar'}
        />
      )}
    </AppShell>
  );
}
