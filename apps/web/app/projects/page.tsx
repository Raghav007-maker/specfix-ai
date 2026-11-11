import type { ReactNode } from 'react';
import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  listProjectDetails,
  listProjects,
  summarizeCounts,
  workCountRows,
  workTablesAvailable,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import { Card, EmptyNote } from '@/components/ui';
import { NotMigrated, ProgressBar, ProjectStatusPill } from './work-ui';

export default async function ProjectsPage() {
  const user = await requireUser();
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t), workTablesAvailable()]);

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
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.012em]">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tasks, progress and activity for each project. Spec review stays in each project&apos;s
          queue.
        </p>
      </div>
      {children}
    </AppShell>
  );

  if (!migrated) return shell(<NotMigrated />);

  const [details, rows] = await Promise.all([listProjectDetails(t), workCountRows(t)]);
  if (details.length === 0) {
    return shell(
      <EmptyNote>
        No projects yet.{' '}
        {tenant.role === 'reviewer'
          ? 'Ask an owner or admin to create one.'
          : 'Create one from the home page.'}
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
