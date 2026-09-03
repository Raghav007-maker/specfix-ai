import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { requireTenant, currentMemberships } from '@/lib/tenant';
import { listProjects, ticketQueue, type TicketQueueRow } from '@/lib/repos';
import { switchTenant, createProjectForCurrentTenant } from './actions';
import { AppHeader } from '@/components/app-header';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const user = await requireUser();
  const tenant = await requireTenant(user.id);
  const memberships = await currentMemberships(user.id);
  const projects = await listProjects(tenant.tenant_id);

  const { project: projectParam } = await searchParams;
  const activeProject = projects.find((p) => p.id === projectParam) ?? projects[0];
  const queue = activeProject ? await ticketQueue(tenant.tenant_id, activeProject.id) : [];

  return (
    <>
      <AppHeader user={user} tenant={tenant} />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
            <p className="text-sm text-muted-foreground">
              Tickets analyzed for ambiguity, waiting on a reviewer.
            </p>
          </div>
          <div className="flex items-center gap-4">
            {memberships.length > 1 ? (
              <form action={switchTenant} className="flex items-center gap-2">
                <select
                  name="tenantId"
                  defaultValue={tenant.tenant_id}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {memberships.map((m) => (
                    <option key={m.tenant_id} value={m.tenant_id}>
                      {m.tenant_name}
                    </option>
                  ))}
                </select>
                <Button type="submit" size="sm" variant="outline">
                  Switch
                </Button>
              </form>
            ) : null}
          </div>
        </div>

        {projects.length > 1 ? (
          <div className="mb-6 flex flex-wrap gap-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/?project=${p.id}`}
                className={
                  p.id === activeProject?.id
                    ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                    : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent'
                }
              >
                {p.name}
              </Link>
            ))}
          </div>
        ) : null}

        {projects.length === 0 ? (
          <NoProjects />
        ) : queue.length === 0 ? (
          <EmptyQueue projectName={activeProject?.name ?? ''} />
        ) : (
          <Card>
            <ul className="divide-y">
              {queue.map((row) => (
                <QueueItem key={row.ticket_id} row={row} />
              ))}
            </ul>
          </Card>
        )}
      </main>
    </>
  );
}

function QueueItem({ row }: { row: TicketQueueRow }) {
  return (
    <li>
      <Link
        href={`/tickets/${row.ticket_id}`}
        className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-accent/50"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{row.external_key}</span>
          </div>
          <p className="truncate font-medium">{row.title}</p>
        </div>
        <QueueStatus row={row} />
      </Link>
    </li>
  );
}

function QueueStatus({ row }: { row: TicketQueueRow }) {
  if (!row.analyzed) return <Badge tone="neutral">Not analyzed</Badge>;
  if (row.ready) return <Badge tone="success">Ready for dev</Badge>;
  if (row.open_flags > 0)
    return (
      <Badge tone="warning">
        {row.open_flags} open {row.open_flags === 1 ? 'flag' : 'flags'}
      </Badge>
    );
  if (row.total_flags > 0) return <Badge tone="primary">Flags resolved</Badge>;
  return <Badge tone="muted">No flags</Badge>;
}

function NoProjects() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No projects yet</CardTitle>
        <p className="text-sm text-muted-foreground">
          Create a project, then ingest tickets into it to start reviewing.
        </p>
      </CardHeader>
      <CardContent>
        <form action={createProjectForCurrentTenant} className="flex gap-2">
          <Input name="name" placeholder="Project name" required className="max-w-xs" />
          <Button type="submit">Create project</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function EmptyQueue({ projectName }: { projectName: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        No tickets in <span className="font-medium text-foreground">{projectName}</span> yet. Ingest
        tickets into this project — the worker analyzes them and they appear here.
      </CardContent>
    </Card>
  );
}
