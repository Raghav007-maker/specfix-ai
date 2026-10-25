import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { requireTenant, currentMemberships } from '@/lib/tenant';
import { listProjects, ticketQueue } from '@/lib/repos';
import { createProjectForCurrentTenant } from './actions';
import { AppHeader } from '@/components/app-header';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorBanner,
  Input,
  Stat,
} from '@/components/ui';
import { FILTERS, QueueItem, type Filter } from '@/components/queue';
import { cn } from '@/lib/cn';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; status?: string; error?: string }>;
}) {
  const user = await requireUser();

  // One membership read, reused for both the tenant choice and the workspace menu instead
  // of querying the same table twice. searchParams is independent, so resolve it alongside.
  const [memberships, { project: projectParam, status, error }] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const projects = await listProjects(tenant.tenant_id);

  const activeProject = projects.find((p) => p.id === projectParam) ?? projects[0];
  const queue = activeProject ? await ticketQueue(tenant.tenant_id, activeProject.id) : [];

  const filter: Filter = status && status in FILTERS ? (status as Filter) : 'all';
  const visible = queue.filter(FILTERS[filter].match);
  const totals = {
    open: queue.reduce((sum, r) => sum + (r.ready ? 0 : r.open_flags), 0),
    ready: queue.filter(FILTERS.ready.match).length,
    pending: queue.filter(FILTERS.pending.match).length,
  };
  const canCreateProject = tenant.role !== 'reviewer';

  return (
    <>
      <AppHeader user={user} tenant={tenant} memberships={memberships} active="queue" />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
            <p className="text-sm text-muted-foreground">
              Tickets analyzed for ambiguity, waiting on a reviewer.
            </p>
          </div>
        </div>

        <ErrorBanner message={error} />

        {projects.length > 0 ? (
          <div className="mb-6 flex flex-wrap gap-2">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/?project=${p.id}`}
                className={cn(
                  'rounded-full px-4 py-1.5 text-xs font-semibold transition-colors',
                  p.id === activeProject?.id
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'border border-primary/30 bg-card text-primary hover:bg-accent'
                )}
              >
                {p.name}
              </Link>
            ))}
          </div>
        ) : null}

        {projects.length === 0 ? (
          <NoProjects canCreate={canCreateProject} />
        ) : (
          <>
            <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Tickets" value={queue.length} />
              <Stat label="Open flags" value={totals.open} hint="across tickets not yet ready" />
              <Stat label="Ready for dev" value={totals.ready} />
              <Stat label="Not analyzed" value={totals.pending} />
            </dl>

            {queue.length === 0 ? (
              <EmptyQueue projectName={activeProject?.name ?? ''} />
            ) : (
              <Card className="overflow-hidden">
                <div className="flex flex-wrap gap-1 border-b bg-muted/40 px-3 py-2">
                  {(Object.keys(FILTERS) as Filter[]).map((key) => {
                    const count = queue.filter(FILTERS[key].match).length;
                    return (
                      <Link
                        key={key}
                        href={`/?project=${activeProject?.id ?? ''}${key === 'all' ? '' : `&status=${key}`}`}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs font-medium',
                          filter === key
                            ? 'bg-card text-primary shadow-sm ring-1 ring-border'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {FILTERS[key].label}
                        <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
                      </Link>
                    );
                  })}
                </div>
                {visible.length === 0 ? (
                  <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                    No tickets match this filter.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {visible.map((row) => (
                      <QueueItem key={row.ticket_id} row={row} />
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </>
        )}
      </main>
    </>
  );
}

function NoProjects({ canCreate }: { canCreate: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No projects yet</CardTitle>
        <p className="text-sm text-muted-foreground">
          {canCreate
            ? 'Create a project, then ingest tickets into it to start reviewing.'
            : 'An owner or admin needs to create a project before there is anything to review.'}
        </p>
      </CardHeader>
      {canCreate ? (
        <CardContent>
          <form action={createProjectForCurrentTenant} className="flex gap-2">
            <Input name="name" placeholder="Project name" required className="max-w-xs" />
            <Button type="submit">Create project</Button>
          </form>
        </CardContent>
      ) : null}
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
