import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import {
  formatMinutes,
  listMembers,
  listProjectJoinRequests,
  listProjectMembers,
  listProjects,
  listWorkEvents,
  projectTracking,
  workTablesAvailable,
  type MemberTrackingRow,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyNote,
  Input,
  Notice,
  Select,
  linkClasses,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { cn } from '@/lib/cn';
import { decideProjectJoinAction, setProjectMemberAction } from '../../actions';
import { NotMigrated, ProjectHeader } from '../../work-ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHEN = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/**
 * Who works on this project, and how their work is going. The owner assigns admins and
 * reviewers from the team; a project admin adds reviewers and can make one an admin. The owner
 * tracks the admins (and everyone else), an admin tracks the reviewers: tasks, hours logged,
 * last activity, and each person's activity log.
 */
export default async function ProjectPeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{
    error?: string;
    notice?: string;
    person?: string;
    role?: string;
    find?: string;
  }>;
}) {
  const [{ projectId }, search, user] = await Promise.all([params, searchParams, requireUser()]);
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);
  const t = tenant.tenant_id;
  const [projects, migrated] = await Promise.all([listProjects(t, user.id), workTablesAvailable()]);
  const sidebarProject = projects.find((p) => p.id === projectId);
  if (!sidebarProject) notFound();
  const myRole = sidebarProject.role;

  const shell = (children: ReactNode) => (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={projectId}
      projectView="people"
      current="projects"
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/projects/${projectId}`, label: sidebarProject.name }}
          current="People"
        />
      }
    >
      <ProjectHeader
        projectId={projectId}
        name={sidebarProject.name}
        active="people"
        canManage={myRole !== 'reviewer'}
      />
      {children}
    </AppShell>
  );
  if (!migrated) return shell(<NotMigrated />);

  const [members, team, tracking, joinRequests] = await Promise.all([
    listProjectMembers(t, projectId),
    myRole === 'reviewer' ? Promise.resolve([]) : listMembers(t),
    myRole === 'reviewer' ? Promise.resolve([]) : projectTracking(t, projectId),
    listProjectJoinRequests(t, user.id, projectId),
  ]);

  // The owner tracks everyone (filterable by role); an admin tracks the reviewers.
  const roleFilter = myRole === 'owner' && search.role === 'admin' ? 'admin' : search.role;
  const tracked = tracking.filter((r) =>
    myRole === 'admin'
      ? r.role === 'reviewer'
      : roleFilter === 'admin' || roleFilter === 'reviewer'
        ? r.role === roleFilter
        : true
  );
  const person =
    search.person && UUID.test(search.person)
      ? tracked.find((r) => r.user_id === search.person)
      : undefined;
  const events = person ? await listWorkEvents(t, { projectId, actorId: person.user_id }, 50) : [];

  const inProject = new Set(members.map((m) => m.user_id));
  const candidates = team.filter((m) => m.role !== 'owner' && !inProject.has(m.user_id));
  const label = (m: { name: string | null; email: string | null }) => m.name ?? m.email ?? 'Member';
  // Find a team member by the name they set (or their email) to add them.
  const find = (search.find ?? '').trim().slice(0, 60);
  const needle = find.toLowerCase();
  const found = find
    ? candidates
        .filter((m) => `${m.name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(needle))
        .slice(0, 10)
    : [];

  return shell(
    <div className="space-y-6">
      {search.error ? <Notice tone="error">{search.error}</Notice> : null}
      {search.notice ? <Notice tone="success">{search.notice}</Notice> : null}

      {joinRequests.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Asking to join{' '}
              <span className="font-normal text-muted-foreground">({joinRequests.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-rule text-sm">
              {joinRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{label(r)}</span>
                    {r.name && r.email ? (
                      <span className="text-muted-foreground"> · {r.email}</span>
                    ) : null}
                  </span>
                  {(['approve', 'reject'] as const).map((decision) => (
                    <form key={decision} action={decideProjectJoinAction}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="requestId" value={r.id} />
                      <input type="hidden" name="decision" value={decision} />
                      <SubmitButton
                        size="sm"
                        variant={decision === 'approve' ? 'outline' : 'ghost'}
                        pendingLabel="…"
                      >
                        {decision === 'approve' ? 'Add as reviewer' : 'Turn down'}
                      </SubmitButton>
                    </form>
                  ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle className="text-base">
              Project members{' '}
              <span className="font-normal text-muted-foreground">({members.length})</span>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Workspace owners see every project and are not listed here.
            </p>
          </CardHeader>
          {members.length === 0 ? (
            <CardContent>
              <EmptyNote>No one has been added to this project yet.</EmptyNote>
            </CardContent>
          ) : (
            <ul className="divide-y divide-rule">
              {members.map((m) => {
                const self = m.user_id === user.id;
                const canPromote = !self && myRole !== 'reviewer' && m.role === 'reviewer';
                const canDemote = !self && myRole === 'owner' && m.role === 'admin';
                const canRemove =
                  !self && (myRole === 'owner' || (myRole === 'admin' && m.role === 'reviewer'));
                return (
                  <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {label(m)}
                        {self ? (
                          <span className="font-normal text-muted-foreground"> (you)</span>
                        ) : null}
                      </p>
                      {m.name && m.email ? (
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      ) : null}
                    </div>
                    <span className="text-xs font-medium capitalize text-muted-foreground">
                      {m.role}
                    </span>
                    {canPromote || canDemote ? (
                      <MemberForm
                        projectId={projectId}
                        userId={m.user_id}
                        role={canPromote ? 'admin' : 'reviewer'}
                        label={canPromote ? 'Make admin' : 'Make reviewer'}
                      />
                    ) : null}
                    {canRemove ? (
                      <MemberForm
                        projectId={projectId}
                        userId={m.user_id}
                        role="remove"
                        label="Remove"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {myRole !== 'reviewer' ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {myRole === 'owner' ? 'Add an admin or reviewer' : 'Add a reviewer'}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Pick someone from the team. New people join the team on the{' '}
                <Link href="/team" className={linkClasses}>
                  Team page
                </Link>{' '}
                first.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {candidates.length > 0 ? (
                <div className="space-y-2">
                  <form method="get" role="search" className="flex gap-2">
                    <Input
                      type="search"
                      name="find"
                      defaultValue={find}
                      maxLength={60}
                      aria-label="Find a team member by name"
                      placeholder="Find by name or email"
                      autoComplete="off"
                    />
                    <SubmitButton variant="outline" pendingLabel="…">
                      Find
                    </SubmitButton>
                  </form>
                  {find ? (
                    found.length === 0 ? (
                      <EmptyNote>Nobody on the team matches “{find}”.</EmptyNote>
                    ) : (
                      <ul className="divide-y divide-rule text-sm">
                        {found.map((m) => (
                          <li key={m.user_id} className="flex flex-wrap items-center gap-2 py-2">
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">{label(m)}</span>
                              {m.name && m.email ? (
                                <span className="text-muted-foreground"> · {m.email}</span>
                              ) : null}
                            </span>
                            {myRole === 'owner' ? (
                              <MemberForm
                                projectId={projectId}
                                userId={m.user_id}
                                role="admin"
                                label="Add as admin"
                              />
                            ) : null}
                            <MemberForm
                              projectId={projectId}
                              userId={m.user_id}
                              role="reviewer"
                              label="Add as reviewer"
                            />
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </div>
              ) : null}
              {candidates.length === 0 ? (
                <EmptyNote>
                  {team.some((m) => m.role !== 'owner')
                    ? 'Everyone on the team is already in this project.'
                    : 'No one else is on the team yet. Add people on the Team page first.'}
                </EmptyNote>
              ) : (
                <form action={setProjectMemberAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />
                  <Select name="userId" aria-label="Team member" required defaultValue="">
                    <option value="" disabled>
                      Choose a team member
                    </option>
                    {candidates.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.name ? `${m.name} (${m.email ?? ''})` : (m.email ?? 'Member')}
                      </option>
                    ))}
                  </Select>
                  {myRole === 'owner' ? (
                    <Select name="role" aria-label="Project role" defaultValue="admin">
                      <option value="admin">Admin</option>
                      <option value="reviewer">Reviewer</option>
                    </Select>
                  ) : (
                    <input type="hidden" name="role" value="reviewer" />
                  )}
                  <SubmitButton pendingLabel="Adding…">Add to project</SubmitButton>
                </form>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {myRole !== 'reviewer' ? (
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                {myRole === 'owner' ? 'Tracking' : 'Reviewer tracking'}
              </CardTitle>
              {myRole === 'owner' ? (
                <nav aria-label="Filter by role" className="flex gap-1 text-sm">
                  {[
                    ['', 'Everyone'],
                    ['admin', 'Admins'],
                    ['reviewer', 'Reviewers'],
                  ].map(([value, text]) => (
                    <Link
                      key={value}
                      href={`/projects/${projectId}/people${value ? `?role=${value}` : ''}`}
                      aria-current={(roleFilter ?? '') === value ? 'page' : undefined}
                      className={cn(
                        'rounded-md px-2 py-1',
                        (roleFilter ?? '') === value
                          ? 'bg-raised font-medium'
                          : 'text-muted-foreground hover:text-text'
                      )}
                    >
                      {text}
                    </Link>
                  ))}
                </nav>
              ) : null}
            </div>
          </CardHeader>
          {tracked.length === 0 ? (
            <CardContent>
              <EmptyNote>No one to track yet.</EmptyNote>
            </CardContent>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 font-medium">Person</th>
                    <th className="px-2 py-2 text-right font-medium">Assigned</th>
                    <th className="px-2 py-2 text-right font-medium">In progress</th>
                    <th className="px-2 py-2 text-right font-medium">Done</th>
                    <th className="px-2 py-2 text-right font-medium">Overdue</th>
                    <th className="px-2 py-2 text-right font-medium">Hours</th>
                    <th className="px-4 py-2 font-medium">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {tracked.map((r) => (
                    <TrackingRow
                      key={r.user_id}
                      row={r}
                      href={`/projects/${projectId}/people?${new URLSearchParams({
                        ...(roleFilter ? { role: roleFilter } : {}),
                        person: r.user_id,
                      })}#activity`}
                      selected={person?.user_id === r.user_id}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {person ? (
        <Card id="activity" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-base">Activity of {label(person)}</CardTitle>
            <p className="text-sm text-muted-foreground">
              What they changed in this project, newest first (last 50).
            </p>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <EmptyNote>Nothing yet.</EmptyNote>
            ) : (
              <ul className="space-y-2 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-2">
                    <span className="tabular-nums text-muted-foreground">
                      {WHEN.format(e.created_at)}
                    </span>
                    <span>
                      {e.kind.replace(/_/g, ' ')}
                      {e.field ? ` ${e.field}` : ''}
                      {e.item_number ? ` on #${e.item_number}` : ''}
                      {e.item_title ? ` · ${e.item_title}` : ''}
                      {e.to_value ? ` → ${e.to_value.slice(0, 80)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function MemberForm({
  projectId,
  userId,
  role,
  label,
}: {
  projectId: string;
  userId: string;
  role: 'admin' | 'reviewer' | 'remove';
  label: string;
}) {
  return (
    <form action={setProjectMemberAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="role" value={role} />
      <SubmitButton variant={role === 'remove' ? 'ghost' : 'outline'} size="sm" pendingLabel="…">
        {label}
      </SubmitButton>
    </form>
  );
}

function TrackingRow({
  row,
  href,
  selected,
}: {
  row: MemberTrackingRow;
  href: string;
  selected: boolean;
}) {
  return (
    <tr className={cn(selected && 'bg-raised')}>
      <td className="px-4 py-2">
        <Link href={href} className={linkClasses}>
          {row.name ?? row.email ?? 'Member'}
        </Link>{' '}
        <span className="text-xs capitalize text-muted-foreground">{row.role}</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{row.assigned}</td>
      <td className="px-2 py-2 text-right tabular-nums">{row.in_progress}</td>
      <td className="px-2 py-2 text-right tabular-nums">{row.done}</td>
      <td className={cn('px-2 py-2 text-right tabular-nums', row.overdue > 0 && 'text-negative')}>
        {row.overdue}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{formatMinutes(row.minutes)}</td>
      <td className="px-4 py-2 text-muted-foreground">
        {row.last_active ? WHEN.format(row.last_active) : 'Never'}
      </td>
    </tr>
  );
}
