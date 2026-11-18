import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import { getProjectDetail, listProjects, workTablesAvailable } from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Notice,
  Textarea,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { updateProjectAction } from '../../actions';
import { NotMigrated, ProjectHeader, ProjectStatusForm, ProjectStatusPill } from '../../work-ui';

/** A project's details (description, task key) and status. Owners and admins see it; only owners change the status. */
export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const [{ projectId }, { error, notice }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t, user.id), workTablesAvailable()]);
  const sidebarProject = projects.find((p) => p.id === projectId);
  if (!sidebarProject) notFound();
  const canManage = sidebarProject.role !== 'reviewer';

  const shell = (children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      projectView="settings"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="Settings"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="settings"
        canManage={canManage}
      />
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);
  if (!canManage) {
    return shell(
      <Notice tone="info" title="Only owners and admins change project settings">
        Ask an owner or admin of this workspace to change the project&apos;s details.
      </Notice>
    );
  }

  const project = await getProjectDetail(t, projectId);
  if (!project) notFound();

  return shell(
    <div className="max-w-2xl space-y-6">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          <p className="text-sm text-muted-foreground">
            Yellow means the project is running, green means it is completed. Only an owner can
            change it, and it can be changed back at any time.
          </p>
        </CardHeader>
        <CardContent>
          {sidebarProject.role === 'owner' ? (
            <ProjectStatusForm projectId={projectId} status={project.status} from="settings" />
          ) : (
            <ProjectStatusPill status={project.status} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project details</CardTitle>
          <p className="text-sm text-muted-foreground">
            {project.source_type === 'jira'
              ? `Spec tickets sync from Jira project ${project.jira_project_key}.`
              : 'Spec tickets come from file import.'}
          </p>
        </CardHeader>
        <CardContent>
          <form action={updateProjectAction} className="space-y-4">
            <input type="hidden" name="projectId" value={projectId} />
            <div className="space-y-1.5">
              <Label htmlFor="project-description">Description</Label>
              <Textarea
                id="project-description"
                name="description"
                rows={4}
                maxLength={5000}
                defaultValue={project.description}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="project-key">Task key</Label>
                <Input
                  id="project-key"
                  name="taskKey"
                  maxLength={10}
                  autoComplete="off"
                  defaultValue={project.task_key ?? ''}
                  placeholder="Set from the name on the first task"
                  className="font-mono uppercase"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A task key is 2–10 letters or digits. Changing it renames every task id in this
              project.
            </p>
            <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
