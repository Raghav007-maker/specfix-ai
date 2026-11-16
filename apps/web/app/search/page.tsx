import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  listProjectDetails,
  listProjects,
  searchWorkItems,
  taskKeyOf,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import { EmptyNote, linkClasses } from '@/components/ui';
import { PriorityPill, StatusPill } from '../projects/work-ui';

/** The top bar's search: projects by name and tasks by title or id, across the workspace. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const q = (raw ?? '').trim().slice(0, 100);
  const [projects, migrated] = await Promise.all([listProjects(t), workTablesAvailable()]);
  const [details, tasks] =
    migrated && q ? await Promise.all([listProjectDetails(t), searchWorkItems(t, q)]) : [[], []];
  const byId = new Map(details.map((p) => [p.id, p]));
  const needle = q.toLowerCase();
  const projectHits = q ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : [];

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="queue"
      breadcrumb={<p className="text-sm text-muted-foreground">Search</p>}
    >
      <h1 className="mb-1 text-2xl font-semibold tracking-[-0.012em]">Search</h1>
      <form method="get" role="search" className="mb-6 flex max-w-xl gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          aria-label="Search tasks and projects"
          placeholder="Task title, task id like CF-12, or project name"
          maxLength={100}
          className="h-10 w-full rounded-md border border-border bg-sheet px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
        />
      </form>

      {!q ? (
        <EmptyNote>Type a task title, a task id such as CF-12, or a project name.</EmptyNote>
      ) : (
        <div className="space-y-8">
          {projectHits.length > 0 ? (
            <section aria-labelledby="sp-h">
              <h2 id="sp-h" className="mb-2 text-sm font-semibold">
                Projects
              </h2>
              <ul className="flex flex-wrap gap-2">
                {projectHits.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/projects/${p.id}`}
                      className="inline-flex h-9 items-center rounded-md border border-border bg-sheet px-3 text-sm hover:bg-raised"
                    >
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="st-h">
            <h2 id="st-h" className="mb-2 text-sm font-semibold">
              Tasks <span className="font-normal text-muted-foreground">{tasks.length}</span>
            </h2>
            {tasks.length === 0 ? (
              <EmptyNote>No task matches “{q}”.</EmptyNote>
            ) : (
              <ul className="divide-y divide-rule rounded-lg border border-border bg-sheet">
                {tasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                  >
                    <Link
                      href={`/projects/${task.project_id}/tasks/${task.number}`}
                      className={`${linkClasses} font-mono text-[13px]`}
                    >
                      {taskKeyOf(byId.get(task.project_id)?.task_key ?? null, task.number)}
                    </Link>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{task.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {byId.get(task.project_id)?.name ?? 'Project'}
                      </span>
                    </span>
                    <PriorityPill priority={task.priority} />
                    <StatusPill status={task.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
