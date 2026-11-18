import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  listMembers,
  listProjectDetails,
  listProjects,
  summarizeCounts,
  workCountRows,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import { Card, EmptyNote } from '@/components/ui';
import { NotMigrated, ProgressBar, ProjectStatusPill } from './work-ui';
import { Input, Notice, Select } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { cn } from '@/lib/cn';
import { createProjectForCurrentTenant } from '../actions';

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; new?: string }>;
}) {
  const [user, { error, new: fromCreate }] = await Promise.all([requireUser(), searchParams]);
  // Arrived from the top bar's "Create project": put the cursor in the name field.
  const focusCreate = fromCreate === '1';
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated, people] = await Promise.all([
    listProjects(t, user.id),
    workTablesAvailable(),
    // Who an owner can name as a new project's admin: everyone but the owners.
    tenant.role === 'owner' ? listMembers(t) : Promise.resolve([]),
  ]);

  const breadcrumb = (
    <p className="flex min-w-0 items-center gap-2 text-sm">
      <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
      <span aria-hidden className="text-muted-foreground">
        /
      </span>
      <span className="truncate">Projects</span>
    </p>
  );
  const shell = (children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="projects"
      breadcrumb={breadcrumb}
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.012em]">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tasks, progress and activity for each project. Spec review stays in each project&apos;s
            queue.
          </p>
        </div>
        {tenant.role === 'owner' ? (
          <form
            id="new-project"
            action={createProjectForCurrentTenant}
            className={cn(
              'flex scroll-mt-20 flex-wrap items-center gap-2 rounded-lg p-1',
              focusCreate && 'bg-raised ring-2 ring-teal'
            )}
          >
            <input type="hidden" name="from" value="projects" />
            <Input
              name="name"
              aria-label="New project name"
              placeholder="New project name"
              autoComplete="off"
              required
              maxLength={100}
              autoFocus={focusCreate}
              className="w-56"
            />
            <Select name="adminId" aria-label="Project admin" defaultValue="" className="w-56">
              <option value="">Admin: choose later</option>
              {people
                .filter((m) => m.role !== 'owner')
                .map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name ?? m.email ?? 'Member'}
                    {m.name && m.email ? ` (${m.email})` : ''}
                  </option>
                ))}
            </Select>
            <SubmitButton pendingLabel="Creating…">Create project</SubmitButton>
          </form>
        ) : null}
      </div>
      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}
      {children}
    </AppShell>
  );

  if (!migrated) return shell(<NotMigrated />);

  const visible = new Set(projects.map((p) => p.id));
  const [allDetails, allRows] = await Promise.all([listProjectDetails(t), workCountRows(t)]);
  const details = allDetails.filter((d) => visible.has(d.id));
  const rows = allRows.filter((r) => visible.has(r.project_id));
  if (details.length === 0) {
    return shell(
      <EmptyNote>
        No projects yet.{' '}
        {tenant.role !== 'owner'
          ? 'Ask an owner to add you to a project.'
          : 'Create one with “Create project” above.'}
      </EmptyNote>
    );
  }

  return shell(
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {details.map((p) => {
        const counts = summarizeCounts(rows.filter((r) => r.project_id === p.id));
        return (
          <li key={p.id}>
            <Card className="flex h-full flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 text-base font-semibold">
                  <Link
                    href={`/projects/${p.id}`}
                    className="rounded-sm underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                  >
                    {p.name}
                  </Link>
                </h2>
                <ProjectStatusPill status={p.status} />
              </div>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {p.description || 'No description yet.'}
              </p>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <Stat label="Tasks" value={counts.total} />
                <Stat
                  label="In progress"
                  value={counts.byStatus.in_progress + counts.byStatus.in_review}
                />
                <Stat label="Overdue" value={counts.overdue} warn={counts.overdue > 0} />
              </dl>
              <div className="mt-auto">
                <ProgressBar done={counts.byStatus.done} total={counts.total} label="Progress" />
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={warn ? 'font-semibold tabular-nums text-negative' : 'font-semibold tabular-nums'}
      >
        {value}
      </dd>
    </div>
  );
}
