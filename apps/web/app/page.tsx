import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { getUser } from '@/lib/session';
import { Landing } from '@/components/landing/landing';
import { requireTenant, currentMemberships } from '@/lib/tenant';
import { listProjects, ticketQueue, type TicketQueueRow } from '@/lib/repos';
import { switchTenant, createProjectForCurrentTenant } from './actions';
import { AppShell } from '@/components/app-shell';
import { Button, Input, Notice, Select, buttonClasses } from '@/components/ui';
import { cn } from '@/lib/cn';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; error?: string }>;
}) {
  // Signed-out visitors get the public landing page; signed-in users get their queue. Every
  // existing redirect to "/" comes from a signed-in flow, so it still lands on the queue.
  const user = await getUser();
  if (!user) return <Landing />;

  // One membership read, reused for both the tenant choice and the org switcher instead
  // of querying the same table twice. searchParams is independent, so resolve it alongside.
  const [memberships, { project: projectParam, error }] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const projects = await listProjects(tenant.tenant_id);

  const activeProject = projects.find((p) => p.id === projectParam) ?? projects[0];
  const queue = activeProject ? await ticketQueue(tenant.tenant_id, activeProject.id) : [];

  // The same rows, grouped by what the reviewer should do next.
  const needsDecision = queue
    .filter((r) => r.analyzed && !r.ready && r.open_flags > 0)
    .sort((a, b) => b.open_flags - a.open_flags);
  const notAnalyzed = queue.filter((r) => !r.analyzed);
  const resolved = queue.filter((r) => r.analyzed && !r.ready && r.open_flags === 0);
  const ready = queue.filter((r) => r.ready);

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={activeProject?.id}
      current="queue"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Review queue</span>
        </p>
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.012em]">Review queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activeProject
              ? `${plural(queue.length, 'ticket')} in ${activeProject.name}`
              : 'Tickets analysed for ambiguity, waiting on a reviewer.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {projects.length > 1 ? (
            <nav
              aria-label="Project"
              className="inline-flex max-w-full overflow-x-auto rounded-lg bg-frame p-[3px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.5),0_0_0_1px_rgb(var(--border))]"
            >
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/?project=${p.id}`}
                  aria-current={p.id === activeProject?.id ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-7 items-center whitespace-nowrap rounded-md px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-sm:h-10',
                    p.id === activeProject?.id
                      ? 'bg-active text-text shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_0_0_1px_rgb(var(--control))]'
                      : 'text-muted-foreground hover:text-text'
                  )}
                >
                  {p.name}
                </Link>
              ))}
            </nav>
          ) : null}
          {memberships.length > 1 ? (
            <form action={switchTenant} className="flex items-center gap-2">
              <Select
                name="tenantId"
                aria-label="Workspace"
                defaultValue={tenant.tenant_id}
                className="h-8 w-auto"
              >
                {memberships.map((m) => (
                  <option key={m.tenant_id} value={m.tenant_id}>
                    {m.tenant_name}
                  </option>
                ))}
              </Select>
              <Button type="submit" size="sm" variant="outline">
                Switch
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      {error ? (
        <Notice tone="error" className="mt-6">
          {error}
        </Notice>
      ) : null}

      {projects.length === 0 ? (
        <NoProjects />
      ) : queue.length === 0 ? (
        <EmptyQueue projectName={activeProject?.name ?? ''} />
      ) : (
        <div className="mt-6 grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_340px]">
          <NeedsDecision rows={needsDecision} />
          <div className="space-y-6">
            <Lane
              title="Not analysed yet"
              why="The worker has not finished a run on the latest version."
              dot="hollow"
              rows={notAnalyzed}
            />
            <Lane
              title="Flags resolved"
              why="Every flag decided, or none raised; not yet marked ready."
              dot="bg-teal-ink/70"
              rows={resolved}
            />
            <Lane
              title="Ready for development"
              why="Marked ready on the latest version."
              dot="bg-positive"
              rows={ready}
            />
          </div>
        </div>
      )}
    </AppShell>
  );
}

/** The decisions waiting on the reviewer: the ticket with the most open flags leads. */
function NeedsDecision({ rows }: { rows: TicketQueueRow[] }) {
  const [next, ...rest] = rows;
  return (
    <section
      aria-labelledby="needs-h"
      className="rounded-xl border border-border bg-raised/60 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_24px_48px_-24px_rgb(0_0_0/0.7)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-4">
        <h2 id="needs-h" className="text-[15px] font-semibold">
          Needs your decision
          <span className="ml-2 font-mono text-[13px] font-normal text-muted-foreground">
            {rows.length}
          </span>
        </h2>
        <p className="text-[13px] text-muted-foreground">Most open flags first</p>
      </div>

      {next ? (
        <>
          <div className="grid items-center gap-x-5 gap-y-1.5 border-b border-rule px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <p className="flex items-center gap-2 text-[12.5px] text-teal sm:col-span-2">
              <span aria-hidden className="h-px w-3.5 bg-teal" />
              Next up
            </p>
            <p className="break-words text-lg font-medium leading-snug">{next.title}</p>
            <Link
              href={`/tickets/${next.ticket_id}`}
              className={cn(buttonClasses('default'), 'max-sm:mt-2 max-sm:justify-self-start sm:row-span-2')}
            >
              Continue review
              <ChevronRight aria-hidden size={14} strokeWidth={2} />
            </Link>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
              <span className="font-mono">{next.external_key}</span>
              <span>{openOf(next)}</span>
              <FlagCells row={next} />
            </p>
          </div>
          {rest.length > 0 ? (
            <ul>
              {rest.map((row) => (
                <li key={row.ticket_id} className="border-t border-rule first:border-t-0">
                  <Link
                    href={`/tickets/${row.ticket_id}`}
                    className="group grid items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-text/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal sm:grid-cols-[88px_minmax(0,1fr)_auto_16px]"
                  >
                    <span className="font-mono text-[12.5px] text-muted-foreground">
                      {row.external_key}
                    </span>
                    <span className="truncate font-medium max-sm:whitespace-normal">{row.title}</span>
                    <span className="flex items-center gap-3 whitespace-nowrap text-[13px] text-muted-foreground">
                      {openOf(row)}
                      <FlagCells row={row} />
                    </span>
                    <ChevronRight
                      aria-hidden
                      size={14}
                      className="text-control transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-text max-sm:hidden"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          Nothing is waiting on you in this project.
        </p>
      )}
    </section>
  );
}

/** A quieter group for the other states. */
function Lane({
  title,
  why,
  dot,
  rows,
}: {
  title: string;
  why: string;
  dot: string;
  rows: TicketQueueRow[];
}) {
  return (
    <section aria-label={title}>
      <h2 className="flex items-center gap-2 text-[13.5px] font-medium text-text/85">
        <span
          aria-hidden
          className={cn(
            'h-[7px] w-[7px] flex-none rounded-full',
            dot === 'hollow' ? 'shadow-[inset_0_0_0_1.5px_rgb(var(--muted))]' : dot
          )}
        />
        {title}
        <span className="ml-auto font-mono text-[12.5px] font-normal text-muted-foreground">
          {rows.length}
        </span>
      </h2>
      <p className="mt-0.5 text-[12.5px] text-muted-foreground">{why}</p>
      <ul className="mt-2.5 overflow-hidden rounded-lg border border-border bg-frame/60">
        {rows.length === 0 ? (
          <li className="px-3.5 py-2.5 text-[13px] text-muted-foreground">None right now.</li>
        ) : (
          rows.map((row) => (
            <li key={row.ticket_id} className="border-t border-rule first:border-t-0">
              <Link
                href={`/tickets/${row.ticket_id}`}
                className="grid grid-cols-[76px_minmax(0,1fr)] items-baseline gap-3 px-3.5 py-2.5 text-[13.5px] text-text/85 transition-colors hover:bg-text/[0.02] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal"
              >
                <span className="font-mono text-[12.5px] text-muted-foreground">
                  {row.external_key}
                </span>
                <span className="truncate">{row.title}</span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

/** One small cell per flag on the latest version, filled once decided. */
function FlagCells({ row }: { row: TicketQueueRow }) {
  if (row.total_flags === 0 || row.total_flags > 12) return null;
  const decided = row.total_flags - row.open_flags;
  return (
    <span aria-hidden className="inline-flex gap-[3px]">
      {Array.from({ length: row.total_flags }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-[9px] w-[9px] rounded-[2px]',
            i < decided ? 'bg-text/70' : 'bg-active shadow-[inset_0_0_0_1px_rgb(var(--control))]'
          )}
        />
      ))}
    </span>
  );
}

function openOf(row: TicketQueueRow): string {
  return `${row.open_flags} of ${plural(row.total_flags, 'flag')} open`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function NoProjects() {
  return (
    <section
      aria-labelledby="no-projects-h"
      className="mt-6 max-w-xl rounded-xl border border-border bg-raised/60 p-5"
    >
      <h2 id="no-projects-h" className="font-semibold">
        No projects yet
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Create a project, then ingest tickets into it to start reviewing.
      </p>
      <form action={createProjectForCurrentTenant} className="mt-4 flex gap-2">
        <Input
          name="name"
          aria-label="Project name"
          placeholder="Project name"
          autoComplete="off"
          required
          className="max-w-xs"
        />
        <Button type="submit">Create project</Button>
      </form>
    </section>
  );
}

function EmptyQueue({ projectName }: { projectName: string }) {
  return (
    <p className="mt-6 rounded-xl border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">
      No tickets in <span className="font-medium text-text">{projectName}</span> yet. Ingest
      tickets into this project — the worker analyzes them and they appear here.
    </p>
  );
}
