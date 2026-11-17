import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  ROLES,
  assignableRoles,
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
  }>;
}) {
  const user = await requireUser();
  const [memberships, params] = await Promise.all([currentMemberships(user.id), searchParams]);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [members, projects, migrated] = await Promise.all([
    listMembers(t),
    listProjects(t),
    workTablesAvailable(),
  ]);
  const [details, work]: [ProjectDetailRow[], WorkItemRow[]] = migrated
    ? await Promise.all([listProjectDetails(t), listOpenAssignedWork(t)])
    : [[], []];

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
    if (roleFilter && m.role !== roleFilter) return false;
    if (q && ![m.email ?? '', m.name ?? ''].some((s) => s.toLowerCase().includes(q))) return false;
    if (projectFilter && workOf(m.user_id).length === 0) return false;
    return true;
  });
  const filtered = Boolean(q || projectFilter || roleFilter);

  const myRole = tenant.role;
  const grantable = assignableRoles(myRole);
  const counts = members.reduce<Record<Role, number>>(
    (acc, m) => ({ ...acc, [m.role]: acc[m.role] + 1 }),
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
                    <RoleBadge role={m.role} />
                  </div>
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
