import { getUser } from '@/lib/session';
import { PublicLanding } from '@/components/public-pages';
import { requireTenant, currentMemberships } from '@/lib/tenant';
import { listProjects } from '@/lib/repos';
import { loadWorkspaceDashboard } from '@/lib/dashboard';
import { switchTenant, createProjectForCurrentTenant } from './actions';
import { WorkspaceDashboard } from '@/components/workspace-dashboard';
import { Button, Input, Notice, Select } from '@/components/ui';
import { PlanNotice } from '@/components/plan-notice';
import { planNoticeFor } from '@/lib/plan';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; error?: string }>;
}) {
  // Signed-out visitors get the public landing page; signed-in users get their queue. Every
  // existing redirect to "/" comes from a signed-in flow, so it still lands on the queue.
  const user = await getUser();
  if (!user) return <PublicLanding />;

  // One membership read, reused for both the tenant choice and the org switcher instead
  // of querying the same table twice. searchParams is independent, so resolve it alongside.
  const [memberships, { project: projectParam, error }] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const projects = await listProjects(tenant.tenant_id);

  // Only a project of this workspace narrows the queue; anything else shows them all.
  const activeProject = projects.find((p) => p.id === projectParam);
  const [{ data, agent }, notice] = await Promise.all([
    loadWorkspaceDashboard(user, tenant, projects, activeProject?.id),
    planNoticeFor(user, tenant),
  ]);

  const top =
    notice || error || memberships.length > 1 || projects.length === 0 ? (
      <div className="space-y-4">
        {/* The home queue has no top bar, so the plan notice sits at the top right here. */}
        {notice ? <PlanNotice notice={notice} className="ml-auto w-fit" /> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {memberships.length > 1 ? (
          <form action={switchTenant} className="flex flex-wrap items-center gap-2">
            <Select
              name="tenantId"
              aria-label="Workspace"
              defaultValue={tenant.tenant_id}
              className="h-9 w-auto"
            >
              {memberships.map((m) => (
                <option key={m.tenant_id} value={m.tenant_id}>
                  {m.tenant_name}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" variant="outline">
              Switch workspace
            </Button>
          </form>
        ) : null}
        {projects.length === 0 ? <NoProjects canCreate={tenant.role !== 'reviewer'} /> : null}
      </div>
    ) : null;

  return (
    <WorkspaceDashboard
      data={data}
      agent={agent}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      activeProjectId={activeProject?.id}
      top={top}
    />
  );
}

/** Owners and admins can create a project here; reviewers are told who can. */
function NoProjects({ canCreate }: { canCreate: boolean }) {
  return (
    <section
      aria-labelledby="no-projects-h"
      className="max-w-xl rounded-xl border border-border bg-sheet p-5"
    >
      <h2 id="no-projects-h" className="font-semibold">
        No projects yet
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {canCreate
          ? 'Create a project, then ingest tickets into it to start reviewing.'
          : 'Ask an owner or admin of this workspace to create a project.'}
      </p>
      {canCreate ? (
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
      ) : null}
    </section>
  );
}
