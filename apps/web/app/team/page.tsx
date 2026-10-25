import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import { ROLES, assignableRoles, listMembers, type Role } from '@/lib/repos';
import { AppHeader } from '@/components/app-header';
import { Card, CardHeader, CardTitle, ErrorBanner } from '@/components/ui';
import { AddMember, MemberItem, RoleCard, RoleRules } from './members';

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await requireUser();
  const [memberships, { error, notice }] = await Promise.all([
    currentMemberships(user.id),
    searchParams,
  ]);
  const tenant = await requireTenant(user.id, memberships);
  const members = await listMembers(tenant.tenant_id);

  const myRole = tenant.role;
  const grantable = assignableRoles(myRole);
  const counts = members.reduce<Record<Role, number>>(
    (acc, m) => ({ ...acc, [m.role]: acc[m.role] + 1 }),
    { owner: 0, admin: 0, reviewer: 0 }
  );

  return (
    <>
      <AppHeader user={user} tenant={tenant} memberships={memberships} active="team" />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">
            Who can work in{' '}
            <span className="font-medium text-foreground">{tenant.tenant_name}</span>, and what each
            role is allowed to do.
          </p>
        </div>

        <ErrorBanner message={error} />
        {notice ? (
          <p className="mb-6 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {notice}
          </p>
        ) : null}

        <section className="mb-6 grid gap-4 md:grid-cols-3">
          {ROLES.map((role) => (
            <RoleCard key={role} role={role} count={counts[role]} mine={role === myRole} />
          ))}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
            <ul className="divide-y">
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
              <AddMember roles={grantable} />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Changing roles</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Only owners and admins can add people or change roles. Ask one of them if you
                    need different access.
                  </p>
                </CardHeader>
              </Card>
            )}
            <RoleRules />
          </div>
        </div>
      </main>
    </>
  );
}
