import Link from 'next/link';
import { WORK_TYPE_LABELS, taskKeyOf, type ProjectDetailRow, type WorkItemRow } from '@/lib/repos';
import { Card, CardContent, CardHeader, CardTitle, EmptyNote, linkClasses } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { fileBugAction } from './actions';
import { StatusPill } from './work-ui';

/** The project tasks that point at a spec ticket, on its Specs tab. */
export function TicketTasks({
  ticketId,
  project,
  tasks,
}: {
  ticketId: string;
  project: ProjectDetailRow;
  tasks: WorkItemRow[];
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            Tasks{' '}
            <span className="font-normal tabular-nums text-muted-foreground">{tasks.length}</span>
          </CardTitle>
          <Link
            href={`/projects/${project.id}?ticket=${ticketId}#new-task`}
            className={`${linkClasses} text-sm`}
          >
            New task for this ticket
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {tasks.length === 0 ? (
          <EmptyNote>No project tasks point at this ticket yet.</EmptyNote>
        ) : (
          <ul className="divide-y divide-rule">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Link
                  href={`/projects/${project.id}/tasks/${task.number}`}
                  className={`${linkClasses} font-mono text-[13px]`}
                >
                  {taskKeyOf(project.task_key, task.number)}
                </Link>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="text-xs text-muted-foreground">{WORK_TYPE_LABELS[task.type]}</span>
                <StatusPill status={task.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Under a failing scenario: a link to the bug already open for it, or a "File bug" button
 * that creates one linked to the scenario and its ticket.
 */
export function FileBugControl({
  ticketId,
  scenarioId,
  project,
  tasks,
}: {
  ticketId: string;
  scenarioId: string;
  project: ProjectDetailRow;
  tasks: WorkItemRow[];
}) {
  const open = tasks.find(
    (t) => t.scenario_id === scenarioId && t.type === 'bug' && t.status !== 'done'
  );
  if (open) {
    return (
      <Link
        href={`/projects/${project.id}/tasks/${open.number}`}
        className={`${linkClasses} text-xs`}
      >
        Bug {taskKeyOf(project.task_key, open.number)} is open for this failure
      </Link>
    );
  }
  return (
    <form action={fileBugAction}>
      <input type="hidden" name="scenarioId" value={scenarioId} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <SubmitButton variant="outline" size="sm" pendingLabel="Filing…">
        File bug
      </SubmitButton>
    </form>
  );
}
