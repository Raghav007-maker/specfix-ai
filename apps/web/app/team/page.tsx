import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  ROLES,
  assignableRoles,
  canRequestProject,
  inProjects,
  listJoinRequests,
  listJoinableProjects,
  listMyJoinRequests,
  listProjectRequests,
  searchTeams,
  listProjectMemberships,
  listMembers,
  listOpenAssignedWork,
  listProjectDetails,
  listProjects,
  taskKeyOf,
  workTablesAvailable,
  type ProjectDetailRow,
  type Role,
  type WorkItemRow,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Input,
  Notice,
  RoleBadge,
  Select,
  buttonClasses,
  linkClasses,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { initialsOf, safeAvatarUrl } from '@/lib/avatar';
import { StatusPill } from '../projects/work-ui';
import { AddMember, MemberItem, RoleCard, RoleRules } from './members';
import { FindTeam, JoinProjects, OwnerRequests, RequestProject } from './requests';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Team, as Jira's People: everyone in the workspace with their photo, role and the tasks they
 * are working on, searchable and filterable by project and role. Below it, the roles and the
 * owner/admin tools to add people and change their roles.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    notice?: string;
    q?: string;
    project?: string;
    role?: string;
    find?: string;
  }>;
}) {
  const user = await requireUser();
  const [memberships, params] = await Promise.all([currentMemberships(user.id), searchParams]);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const find = (params.find ?? '').trim().slice(0, 100);
  const [
    members,
    projects,
    migrated,
    allProjectRoles,
    hits,
    myJoins,
    joins,
    projectRequests,
    asks,
    joinable,
  ] = await Promise.all([
    listMembers(t),
    listProjects(t, user.id),
    workTablesAvailable(),
    listProjectMemberships(t),
    searchTeams(user.id, find),
    listMyJoinRequests(user.id),
    listJoinRequests(t, user.id),
    listProjectRequests(t, user.id),
    canRequestProject(t, user.id),
    listJoinableProjects(t, user.id),
  ]);
  const [details, allWork]: [ProjectDetailRow[], WorkItemRow[]] = migrated
    ? await Promise.all([listProjectDetails(t), listOpenAssignedWork(t)])
    : [[], []];
  // Only what happens in projects this viewer can see.
  const work = inProjects(allWork, projects);
  const projectRoles = inProjects(allProjectRoles, projects);
  const rolesOf = (userId: string) => projectRoles.filter((r) => r.user_id === userId);
  /** Owner, else admin of any project here, else reviewer of one, else their workspace role. */
  const roleOf = (m: { user_id: string; role: Role }): Role => {
    if (m.role === 'owner') return 'owner';
    const mine = rolesOf(m.user_id);
    if (mine.some((r) => r.role === 'admin')) return 'admin';
    return mine.length > 0 ? 'reviewer' : m.role;
  };
  // Owner tracks the admins; an admin tracks the reviewers of the projects they run.
  const adminOf = new Set(
    projectRoles.filter((r) => r.user_id === user.id && r.role === 'admin').map((r) => r.project_id)
  );
  const tracked =
    tenant.role === 'owner'
      ? projectRoles.filter((r) => r.role === 'admin')
      : projectRoles.filter((r) => r.role === 'reviewer' && adminOf.has(r.project_id));
  const nameOf = new Map(members.map((m) => [m.user_id, m.name ?? m.email ?? 'Member']));

  const { error, notice } = params;
  const q = (params.q ?? '').trim().slice(0, 100).toLowerCase();
  const projectFilter = params.project && UUID.test(params.project) ? params.project : '';
  const roleFilter = (ROLES as readonly string[]).includes(params.role ?? '')
    ? (params.role as Role)
    : '';
  const byProject = new Map(details.map((p) => [p.id, p]));
  const workOf = (userId: string) =>
    work.filter(
      (w) => w.assignee_id === userId && (!projectFilter || w.project_id === projectFilter)
    );

  const people = members.filter((m) => {
    if (roleFilter && roleOf(m) !== roleFilter) return false;
    if (q && ![m.email ?? '', m.name ?? ''].some((s) => s.toLowerCase().includes(q))) return false;
    if (projectFilter && workOf(m.user_id).length === 0) return false;
    return true;
  });
  const filtered = Boolean(q || projectFilter || roleFilter);

  const myRole = tenant.role;
  const grantable = assignableRoles(myRole);
  const counts = members.reduce<Record<Role, number>>(
    (acc, m) => ({ ...acc, [roleOf(m)]: acc[roleOf(m)] + 1 }),
    { owner: 0, admin: 0, reviewer: 0 }
  );

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="team"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Team</span>
        </p>
      }
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.012em]">People</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everyone in <span className="font-medium text-text">{tenant.tenant_name}</span>, what
            they are working on, and what each role may do.
            {tenant.role === 'owner' ? ' You own this workspace.' : ''}
          </p>
        </div>
        {grantable.length > 0 ? (
          <a href="#add-member" className={buttonClasses('outline')}>
            Add people
          </a>
        ) : null}
      </div>

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" className="mb-6">
          {notice}
        </Notice>
      ) : null}

      <form
        method="get"
        role="search"
        aria-label="Find people"
        className="mb-4 grid gap-3 rounded-lg border border-border bg-sheet p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
      >
        <Input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          maxLength={100}
          aria-label="Search people"
          placeholder="Search people by name or email"
          autoComplete="off"
        />
        <Select name="project" defaultValue={projectFilter} aria-label="Filter by project">
          <option value="">Any project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Working on {p.name}
            </option>
          ))}
        </Select>
        <Select name="role" defaultValue={roleFilter} aria-label="Filter by role">
          <option value="">Any role</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r[0]!.toUpperCase() + r.slice(1)}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Button type="submit" variant="outline">
            Apply
          </Button>
          {filtered ? (
            <Link href="/team" className={buttonClasses('ghost')}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      <FindTeam find={find} hits={hits} mine={myJoins} />
      {joinable.length > 0 ? <JoinProjects projects={joinable} /> : null}
      {tenant.role === 'owner' ? <OwnerRequests joins={joins} projects={projectRequests} /> : null}
      {asks ? <RequestProject mine={projectRequests} /> : null}

      {tenant.role === 'owner' || adminOf.size > 0 ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">
              {tenant.role === 'owner' ? 'Project admins' : 'Reviewers in your projects'}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Open a project&apos;s People page to see their tasks, hours and activity.
            </p>
          </CardHeader>
          <CardContent>
            {tracked.length === 0 ? (
              <EmptyNote>
                {tenant.role === 'owner'
                  ? 'No project has an admin yet. Assign one on the project’s People page.'
                  : 'No reviewers yet. Add them on your project’s People page.'}
              </EmptyNote>
            ) : (
              <ul className="divide-y divide-rule text-sm">
                {tracked.map((r) => (
                  <li key={`${r.project_id}:${r.user_id}`} className="flex gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {nameOf.get(r.user_id) ?? 'Member'}
                    </span>
                    <Link href={`/projects/${r.project_id}/people`} className={linkClasses}>
                      {r.project_name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <p className="mb-3 text-sm font-medium">
        {people.length} {people.length === 1 ? 'person' : 'people'}
        {filtered ? (
          <span className="font-normal text-muted-foreground"> of {members.length}</span>
        ) : null}
      </p>

      {people.length === 0 ? (
        <div className="mb-8">
          <EmptyNote>No one matches these filters.</EmptyNote>
        </div>
      ) : (
        <ul className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {people.map((m) => {
            const tasks = workOf(m.user_id);
            const overdue = tasks.filter((w) => w.overdue).length;
            const photo = safeAvatarUrl(m.avatar_url);
            const label = m.name ?? m.email ?? 'Member';
            return (
              <li key={m.user_id}>
                <Card className="flex h-full flex-col p-4">
                  <div className="flex items-center gap-3">
                    {photo ? (
                      <img
                        src={photo}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-11 w-11 flex-none rounded-full object-cover"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-raised text-sm font-semibold"
                      >
                        {initialsOf(label)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" title={label}>
                        {label}
                        {m.user_id === user.id ? (
                          <span className="font-normal text-muted-foreground"> (you)</span>
                        ) : null}
                      </p>
                      {m.name && m.email ? (
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      ) : null}
                    </div>
                    <RoleBadge role={roleOf(m)} />
                  </div>
                  {rolesOf(m.user_id).length > 0 ? (
                    <p className="mt-2 flex flex-wrap gap-1 text-xs">
                      {rolesOf(m.user_id).map((r) => (
                        <Link
                          key={r.project_id}
                          href={`/projects/${r.project_id}/people`}
                          className="rounded bg-raised px-1.5 py-0.5 text-muted-foreground hover:text-text"
                        >
                          {r.project_name} · {r.role}
                        </Link>
                      ))}
                    </p>
                  ) : null}
                  <p className="mt-3 flex gap-4 text-xs text-muted-foreground">
                    <span>
                      <span className="font-semibold tabular-nums text-text">{tasks.length}</span>{' '}
                      open {tasks.length === 1 ? 'task' : 'tasks'}
                    </span>
                    {overdue ? (
                      <span className="text-negative">
                        <span className="font-semibold tabular-nums">{overdue}</span> overdue
                      </span>
                    ) : null}
                  </p>
                  {tasks.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                      {tasks.slice(0, 4).map((w) => (
                        <li key={w.id} className="flex items-center gap-2">
                          <Link
                            href={`/projects/${w.project_id}/tasks/${w.number}`}
                            className={cn(linkClasses, 'flex-none font-mono text-[12px]')}
                          >
                            {taskKeyOf(byProject.get(w.project_id)?.task_key ?? null, w.number)}
                          </Link>
                          <span className="min-w-0 flex-1 truncate">{w.title}</span>
                          <StatusPill status={w.status} />
                        </li>
                      ))}
                      {tasks.length > 4 ? (
                        <li className="text-xs text-muted-foreground">+{tasks.length - 4} more</li>
                      ) : null}
                    </ul>
                  ) : (
                    <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                      No open tasks{projectFilter ? ' in this project' : ''}.
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-3 text-lg font-semibold">Roles and access</h2>
      <section aria-label="Roles" className="mb-6 grid gap-4 md:grid-cols-3">
        {ROLES.map((role) => (
          <RoleCard key={role} role={role} count={counts[role]} mine={role === myRole} />
        ))}
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">
                Members{' '}
                <span className="font-normal text-muted-foreground">({members.length})</span>
              </CardTitle>
              {grantable.length === 0 ? (
                <span className="text-xs text-muted-foreground">View only</span>
              ) : null}
            </div>
          </CardHeader>
          <ul className="divide-y divide-rule">
            {members.map((member) => (
              <MemberItem
                key={member.user_id}
                member={member}
                self={member.user_id === user.id}
                myRole={myRole}
              />
            ))}
          </ul>
        </Card>

        <div className="space-y-6">
          {grantable.length > 0 ? (
            <div id="add-member" className="scroll-mt-20">
              <AddMember roles={grantable} />
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Changing roles</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Only owners and admins can add people or change roles. Ask one of them if you need
                  different access.
                </p>
              </CardHeader>
            </Card>
          )}
          <RoleRules />
        </div>
      </div>
    </AppShell>
  );
}
